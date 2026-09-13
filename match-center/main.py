# AI月老 · 匹配中心
# 三层漏斗匹配打分服务：硬筛(规则) -> 粗排(加权算法) -> 精排(LLM可选/规则兜底)
# 端口: 8016   数据: data/matchcenter/users.json + matches.json
import hashlib
import json
import math
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("MATCH_CENTER_DATA_DIR", r"D:\xm\aiyuelao\data\matchcenter"))
DATA_FILE = Path(os.environ.get("MATCH_CENTER_DATA", str(DATA_DIR / "users.json")))
MATCH_FILE = DATA_FILE.parent / "matches.json"
LLM_KEY = os.environ.get("DASHSCOPE_API_KEY", "").strip()
LLM_MODEL = os.environ.get("DASHSCOPE_MODEL", "qwen-plus")
LLM_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

# 粗排权重：兴趣40% + 距离30% + 年龄20% + 活跃度10%
W_HOBBY, W_LOC, W_AGE, W_ACT = 0.4, 0.3, 0.2, 0.1
LOC_DECAY = 0.03          # 距离衰减系数：同城≈1，百公里≈0.05
MAX_PAIRS_FOR_FINE = 10   # 精排至少算粗分前 N 对，控制 LLM 成本
MAX_FINE_WINDOW = 50      # 精排窗口上限：翻页时最多精排到第 50 名，防止 LLM 成本随页码无限增长
MAX_PAGE_SIZE = 50        # 单页最大返回条数
AUTO_BAN_REPORTS = int(os.environ.get("AUTO_BAN_REPORTS", "3"))  # 被举报达该次数自动封禁

_lock = threading.Lock()
app = FastAPI(title="AI月老 · 匹配中心", description="硬筛→粗排→精排 三层漏斗匹配打分")

# ------------------------------------------------------------------
# 数据存储（内存 + JSON 落盘，重启不丢）
#   users.json   — 用户档案与状态（含黑名单/封禁/举报数）
#   matches.json — 已配对记录（用于发现页去重）
# ------------------------------------------------------------------
USERS: dict[str, dict] = {}
MATCHED: set[tuple[str, str]] = set()


def _match_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a <= b else (b, a)


def _save_users():
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(list(USERS.values()), ensure_ascii=False), encoding="utf-8")


def _save_matches():
    MATCH_FILE.parent.mkdir(parents=True, exist_ok=True)
    MATCH_FILE.write_text(
        json.dumps(sorted([list(p) for p in MATCHED]), ensure_ascii=False), encoding="utf-8"
    )


def _load():
    if DATA_FILE.exists():
        try:
            for u in json.loads(DATA_FILE.read_text(encoding="utf-8")):
                USERS[u["id"]] = u
        except Exception:
            pass
    if MATCH_FILE.exists():
        try:
            for pair in json.loads(MATCH_FILE.read_text(encoding="utf-8")):
                if isinstance(pair, list) and len(pair) == 2:
                    MATCHED.add(_match_key(pair[0], pair[1]))
        except Exception:
            pass


_load()

# ------------------------------------------------------------------
# 模型
# ------------------------------------------------------------------
class UserIn(BaseModel):
    id: str
    name: str = ""
    gender: str = "f"                     # m / f
    age: int = 18
    city: str = ""
    tags: list[str] = Field(default_factory=list)
    bio: str = ""
    prefs: str = ""                       # 择偶期望文本（双向契合的关键）
    lat: float | None = None
    lng: float | None = None
    active_at: str | None = None          # ISO 时间
    blocked: list[str] = Field(default_factory=list)   # 本人拉黑的用户 id（单向生效）
    banned: bool = False                  # 被举报/运营封禁
    reports: int = 0                      # 被举报次数


class BulkIn(BaseModel):
    users: list[UserIn]


class PairIn(BaseModel):
    a: str
    b: str


class BlockIn(BaseModel):
    target: str


class ReportIn(BaseModel):
    target: str
    reason: str = ""


# ------------------------------------------------------------------
# 本地向量（中文 2/3-gram 哈希 + 停用词过滤，与 Shidduch 离线方案一致）
# ------------------------------------------------------------------
_STOPGRAMS = frozenset({
    "喜欢", "希望", "一起", "找一", "一个", "性格", "对方", "最好", "生活",
    "工作", "自己", "可以", "认真", "交往", "结婚", "目的", "能够", "接受",
    "认识", "觉得", "感觉", "比较", "非常", "特别", "日常", "爱好", "兴趣",
    "周末", "平时", "常常", "总是", "重要", "契合", "三观", "未来", "规划",
    "支持", "陪伴", "温暖", "开朗", "真诚", "踏实", "稳重", "幽默", "以及",
    "还有", "但是", "因为", "所以", "如果", "我们", "你们", "他们",
})


def _text_vec(text: str, dim: int = 512) -> list[float]:
    vec = [0.0] * dim
    clean = "".join(ch for ch in text if "\u4e00" <= ch <= "\u9fff")
    grams = [clean[i:i + 2] for i in range(len(clean) - 1)]
    grams += [clean[i:i + 3] for i in range(len(clean) - 2)]
    grams = [g for g in grams if len(g) == 3 or g not in _STOPGRAMS]
    if not grams:
        grams = [clean or "文本"]
    for g in grams:
        d = hashlib.md5(g.encode("utf-8")).digest()
        vec[int.from_bytes(d[:4], "big") % dim] += 1.0 if d[4] % 2 == 0 else -1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _profile_text(u: dict) -> str:
    return " ".join([u.get("city", "")] + u.get("tags", []) + [u.get("bio", "")])


def _prefs_text(u: dict) -> str:
    return u.get("prefs", "") or " ".join(u.get("tags", []))


def _hobby_sim(a: dict, b: dict) -> float:
    """兴趣相似度 = 标签 Jaccard 与 偏好-画像向量余弦 的混合。"""
    ta, tb = set(a.get("tags", [])), set(b.get("tags", []))
    jac = len(ta & tb) / len(ta | tb) if ta | tb else 0.0
    if a.get("prefs"):
        cos = max(0.0, _cosine(_text_vec(a["prefs"]), _text_vec(_profile_text(b))))
    elif b.get("prefs"):
        cos = max(0.0, _cosine(_text_vec(_prefs_text(b)), _text_vec(_profile_text(a))))
    else:
        cos = 0.0
    return round(0.5 * jac + 0.5 * cos, 4)


def _distance_km(a: dict, b: dict) -> float | None:
    if a.get("lat") is None or b.get("lat") is None:
        return None
    dlat = math.radians(b["lat"] - a["lat"])
    dlng = math.radians(b["lng"] - a["lng"])
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a["lat"])) * \
        math.cos(math.radians(b["lat"])) * math.sin(dlng / 2) ** 2
    return round(6371 * 2 * math.asin(math.sqrt(h)), 2)


def _age_score(a: dict, b: dict) -> float:
    if not a.get("age") or not b.get("age"):
        return 0.6
    return math.exp(-((a["age"] - b["age"]) ** 2) / 50.0)


def _activity_score(u: dict) -> float:
    ts = u.get("active_at")
    if not ts:
        return 0.5
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        mins = (datetime.now(timezone.utc) - dt).total_seconds() / 60
    except Exception:
        return 0.5
    if mins < 0:
        mins = 0
    if mins < 10:
        return 1.0
    if mins < 60:
        return 0.75
    if mins < 360:
        return 0.5
    if mins < 1440:
        return 0.35
    return 0.15


# ------------------------------------------------------------------
# 三层漏斗
# ------------------------------------------------------------------
def _hard_filter(a: dict, b: dict, include_matched: bool = False) -> bool:
    """第0层硬筛（零成本规则）：性别、封禁、双向黑名单、已配对去重。

    生产可再加 geohash 网格、实名/年龄区间等。
    """
    ga, gb = (a.get("gender") or "f")[0], (b.get("gender") or "f")[0]
    if ga == gb:
        return False
    if b.get("banned"):
        return False
    if b["id"] in (a.get("blocked") or []) or a["id"] in (b.get("blocked") or []):
        return False
    if not include_matched and _match_key(a["id"], b["id"]) in MATCHED:
        return False
    return True


def _coarse(a: dict, b: dict) -> dict:
    """粗排：加权公式 0-100。"""
    hobby = _hobby_sim(a, b)
    dist = _distance_km(a, b)
    loc = math.exp(-dist * LOC_DECAY) if dist is not None else 0.5
    age = _age_score(a, b)
    act = _activity_score(b)
    score = round((hobby * W_HOBBY + loc * W_LOC + age * W_AGE + act * W_ACT) * 100, 1)
    return {
        "coarse": score, "distance_km": dist,
        "parts": {
            "兴趣相似度": round(hobby * 100, 1),
            "距离分": round(loc * 100, 1),
            "年龄契合": round(age * 100, 1),
            "活跃度": round(act * 100, 1),
        },
    }


def _mutual_fit(a: dict, b: dict) -> float:
    """双向契合：A的期望vs B的画像 + B的期望vs A的画像。"""
    fit_a = max(0.0, _cosine(_text_vec(_prefs_text(a)), _text_vec(_profile_text(b)))) if a.get("prefs") else 0.5
    fit_b = max(0.0, _cosine(_text_vec(_prefs_text(b)), _text_vec(_profile_text(a)))) if b.get("prefs") else 0.5
    return (fit_a + fit_b) / 2


def _rule_fine(a: dict, b: dict, mutual: float, dist: float | None) -> tuple[int, str, str]:
    """规则版精排：双向契合映射 0-100 + 事实型中文理由 + 破冰话术。"""
    score = round(min(98.0, 45.0 + mutual * 70.0))
    common = sorted(set(a.get("tags", [])) & set(b.get("tags", [])))
    parts = []
    if dist is not None:
        parts.append(f"相距{dist:.0f}公里" if dist >= 1 else "就在你附近")
    if common:
        parts.append("共同爱好：" + "、".join(common[:3]))
    if a.get("age") and b.get("age") and abs(a["age"] - b["age"]) <= 5:
        parts.append(f"年龄相仿（{a['age']}岁/{b['age']}岁）")
    parts.append(f"双向期望契合度 {round(mutual * 100)}%")
    reason = "；".join(parts) + "。"
    icebreaker = (
        f"看到你也喜欢{common[0]}，最近有去哪玩过吗？" if common
        else f"你好呀，看你也在{b.get('city') or '这里'}，周末一般喜欢干嘛？"
    )
    return score, reason, icebreaker


async def _llm_fine(a: dict, b: dict, coarse: float) -> tuple[int, str, str] | None:
    """LLM 精排：配置 DASHSCOPE_API_KEY 后启用，失败自动回落规则版。"""
    if not LLM_KEY:
        return None
    prompt = (
        "你是婚恋匹配专家。评估以下两人的契合度，只返回JSON：\n"
        '{"score": 0-100整数, "reason": "一句话中文说明为什么般配", "icebreaker": "给A的开场白一句话"}\n'
        f"A：{a.get('name')}，{a.get('age')}岁，{a.get('city')}，标签{a.get('tags')}，"
        f"简介：{a.get('bio')}，期望：{a.get('prefs')}\n"
        f"B：{b.get('name')}，{b.get('age')}岁，{b.get('city')}，标签{b.get('tags')}，"
        f"简介：{b.get('bio')}，期望：{b.get('prefs')}\n"
        f"参考：算法粗排分 {coarse}"
    )
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.post(
                LLM_URL,
                headers={"Authorization": f"Bearer {LLM_KEY}"},
                json={"model": LLM_MODEL, "messages": [{"role": "user", "content": prompt}],
                      "temperature": 0.3},
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            data = json.loads(content[content.index("{"):content.rindex("}") + 1])
            return int(data["score"]), str(data["reason"]), str(data["icebreaker"])
    except Exception:
        return None


# ------------------------------------------------------------------
# 基础接口
# ------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "status": "ok",
        "users": len(USERS),
        "matched_pairs": len(MATCHED),
        "banned": sum(1 for u in USERS.values() if u.get("banned")),
        "llm": bool(LLM_KEY),
    }


@app.post("/users/upsert")
def upsert_user(u: UserIn):
    with _lock:
        # exclude_unset：ANL 同步时不带 blocked/banned/reports，不能把服务端状态覆盖掉
        patch = u.model_dump(exclude_unset=True)
        USERS[u.id] = {**USERS.get(u.id, {}), **patch}
        _save_users()
    return {"ok": True, "total": len(USERS)}


@app.post("/users/bulk")
def bulk(users: BulkIn):
    with _lock:
        for u in users.users:
            USERS[u.id] = {**USERS.get(u.id, {}), **u.model_dump(exclude_unset=True)}
        _save_users()
    return {"ok": True, "total": len(USERS)}


@app.get("/users/{user_id}")
def get_user(user_id: str):
    u = USERS.get(user_id)
    if not u:
        raise HTTPException(404, "user not found")
    return u


@app.delete("/users/{user_id}")
def delete_user(user_id: str):
    with _lock:
        if USERS.pop(user_id, None) is None:
            raise HTTPException(404, "user not found")
        for k in [k for k in MATCHED if user_id in k]:
            MATCHED.discard(k)
        _save_users()
        _save_matches()
    return {"ok": True, "total": len(USERS)}


# ------------------------------------------------------------------
# 黑名单 / 举报 / 封禁
# ------------------------------------------------------------------
@app.post("/users/{user_id}/block")
def block_user(user_id: str, body: BlockIn):
    """把 target 加入 user_id 的黑名单（单向：user_id 不再看到 target）。"""
    with _lock:
        u = USERS.get(user_id)
        if not u:
            raise HTTPException(404, "user not found")
        blocked = set(u.get("blocked") or [])
        blocked.add(body.target)
        u["blocked"] = sorted(blocked)
        _save_users()
    return {"ok": True, "blocked": u["blocked"]}


@app.delete("/users/{user_id}/block/{target}")
def unblock_user(user_id: str, target: str):
    with _lock:
        u = USERS.get(user_id)
        if not u:
            raise HTTPException(404, "user not found")
        u["blocked"] = [x for x in (u.get("blocked") or []) if x != target]
        _save_users()
    return {"ok": True, "blocked": u["blocked"]}


@app.get("/users/{user_id}/blocked")
def list_blocked(user_id: str):
    u = USERS.get(user_id)
    if not u:
        raise HTTPException(404, "user not found")
    return {"user": user_id, "blocked": u.get("blocked") or []}


@app.post("/users/{user_id}/report")
def report_user(user_id: str, body: ReportIn):
    """举报某用户；累计达 AUTO_BAN_REPORTS 次自动封禁。"""
    with _lock:
        if user_id not in USERS:
            raise HTTPException(404, "reporter not found")
        t = USERS.get(body.target)
        if not t:
            raise HTTPException(404, "target not found")
        t["reports"] = int(t.get("reports", 0)) + 1
        auto_banned = False
        if t["reports"] >= AUTO_BAN_REPORTS and not t.get("banned"):
            t["banned"] = True
            auto_banned = True
        _save_users()
    return {"ok": True, "target": body.target, "reports": t["reports"],
            "banned": bool(t.get("banned")), "auto_banned": auto_banned}


@app.post("/users/{user_id}/ban")
def ban_user(user_id: str):
    with _lock:
        u = USERS.get(user_id)
        if not u:
            raise HTTPException(404, "user not found")
        u["banned"] = True
        _save_users()
    return {"ok": True, "user": user_id, "banned": True}


@app.post("/users/{user_id}/unban")
def unban_user(user_id: str):
    with _lock:
        u = USERS.get(user_id)
        if not u:
            raise HTTPException(404, "user not found")
        u["banned"] = False
        u["reports"] = 0
        _save_users()
    return {"ok": True, "user": user_id, "banned": False}


# ------------------------------------------------------------------
# 已配对记录（发现页去重）
# ------------------------------------------------------------------
@app.post("/matches/record")
def record_match(body: PairIn):
    with _lock:
        MATCHED.add(_match_key(body.a, body.b))
        _save_matches()
    return {"ok": True, "matched_pairs": len(MATCHED)}


@app.delete("/matches/record")
def remove_match(body: PairIn):
    with _lock:
        MATCHED.discard(_match_key(body.a, body.b))
        _save_matches()
    return {"ok": True, "matched_pairs": len(MATCHED)}


@app.get("/matches/{user_id}")
def list_matches(user_id: str):
    if user_id not in USERS:
        raise HTTPException(404, "user not found")
    return {"user": user_id, "matches": sorted(b for k in MATCHED if user_id in k for b in k if b != user_id)}


# ------------------------------------------------------------------
# 发现（三层漏斗 + 分页）
# ------------------------------------------------------------------
@app.get("/discover/{user_id}")
async def discover(user_id: str, top_n: int = 10, page: int = 1, include_matched: bool = False):
    """三层漏斗：硬筛 -> 粗排全量 -> 精排窗口 -> 最终分 = 粗排50% + 精排50%。

    - top_n：每页条数（1..50），保留旧参数名以兼容既有调用
    - page：页码，从 1 开始
    - include_matched：是否包含已配对过的人（默认 False，即自动去重）
    """
    a = USERS.get(user_id)
    if not a:
        raise HTTPException(404, "user not found, sync first")

    page = max(1, page)
    top_n = max(1, min(top_n, MAX_PAGE_SIZE))

    # 第0层 硬筛 + 第1层 粗排（全量，零成本）
    coarse_list = []
    for uid, b in USERS.items():
        if uid == user_id or not _hard_filter(a, b, include_matched):
            continue
        c = _coarse(a, b)
        coarse_list.append((c["coarse"], c, b))

    coarse_list.sort(key=lambda x: x[0], reverse=True)
    total = len(coarse_list)

    # 第2层 精排：只算窗口内的人（窗口随页码扩大但封顶，控制 LLM 成本）
    need = page * top_n
    window = min(total, max(MAX_PAIRS_FOR_FINE, min(need, MAX_FINE_WINDOW)))
    results = []
    for coarse_score, c, b in coarse_list[:window]:
        mutual = _mutual_fit(a, b)
        fine = await _llm_fine(a, b, coarse_score)
        if fine is None:
            fine_score, reason, icebreaker = _rule_fine(a, b, mutual, c["distance_km"])
            fine_src = "规则版（未配置LLM）"
        else:
            fine_score, reason, icebreaker = fine
            fine_src = f"LLM:{LLM_MODEL}"
        final = round(0.5 * coarse_score + 0.5 * fine_score, 1)
        u = {k: b.get(k) for k in ("id", "name", "gender", "age", "city", "tags", "bio", "active_at")}
        results.append({
            **u,
            "score": final, "coarse": coarse_score, "fine": fine_score,
            "reason": reason, "icebreaker": icebreaker, "fine_src": fine_src,
            "common_tags": sorted(set(a.get("tags", [])) & set(b.get("tags", []))),
            "distance_km": c["distance_km"],
            "parts": c["parts"],
        })

    results.sort(key=lambda x: x["score"], reverse=True)
    start = (page - 1) * top_n
    items = results[start:start + top_n]
    return {
        "user": user_id,
        "total": total,                       # 通过硬筛的候选人总数
        "page": page,
        "page_size": top_n,
        "window": window,                     # 本次精排覆盖的名次范围
        "has_more": start + len(items) < total,
        "items": items,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8016")))
