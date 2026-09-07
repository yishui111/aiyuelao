# -*- coding: utf-8 -*-
"""
AI月老 · 匹配核心自动化测试
用法: python D:\\xm\\aiyuelao\\test-matching.py
覆盖: 匹配中心(8016) 算法与持久化 / ANL(3001) 集成链路 / Shidduch(8015) / 全服务健康
"""
import sys
import json
import time
import base64
import hashlib
import hmac
import urllib.request
import urllib.error

sys.stdout.reconfigure(encoding="utf-8")

MC = "http://127.0.0.1:8016"
ANL = "http://localhost:3001"
SHD = "http://127.0.0.1:8015"

PASS, FAIL = 0, 0
RESULTS = []


def check(name, cond, detail=""):
    global PASS, FAIL
    mark = "PASS" if cond else "FAIL"
    if cond:
        PASS += 1
    else:
        FAIL += 1
    RESULTS.append(f"[{mark}] {name}" + (f"  ({detail})" if detail else ""))
    print(f"[{mark}] {name}" + (f"  ({detail})" if detail else ""))


def req(url, method="GET", data=None, headers=None, timeout=30):
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, body, h, method=method)
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def mint_token(user_id, phone="+8613800138000"):
    """用与 ANL 相同的 JWT_SECRET 签发测试 token"""
    def b64(d):
        return base64.urlsafe_b64encode(d).rstrip(b"=")
    secret = b"dev-secret-not-for-production-0123456789"
    h = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    p = b64(json.dumps({"userId": user_id, "phone": phone, "exp": 9999999999}).encode())
    sig = b64(hmac.new(secret, h + b"." + p, hashlib.sha256).digest())
    return (h + b"." + p + b"." + sig).decode()


print("=" * 60)
print("A. 匹配中心（8016）核心算法")
print("=" * 60)

# A1 健康
code, d = req(f"{MC}/health")
check("A1 匹配中心健康检查", code == 200 and d.get("status") == "ok", f"users={d.get('users')}")

# A2 准备三个测试用户：同城高契合 / 异地低契合 / 同性(应被硬筛掉)
code, d = req(f"{MC}/users/bulk", "POST", {"users": [
    {"id": "test_m1", "name": "测试男", "gender": "m", "age": 28, "city": "杭州",
     "tags": ["徒步", "摄影", "咖啡"], "bio": "喜欢户外", "prefs": "想找爱摄影爱徒步的女生",
     "lat": 30.25, "lng": 120.15, "active_at": "2026-09-06T00:00:00Z"},
    {"id": "test_f1", "name": "近距女", "gender": "f", "age": 27, "city": "杭州",
     "tags": ["徒步", "摄影", "读书"], "bio": "爱拍照爱爬山", "prefs": "想找稳重爱户外的男生",
     "lat": 30.2505, "lng": 120.1505, "active_at": "2026-09-06T00:00:00Z"},
    {"id": "test_f2", "name": "远距女", "gender": "f", "age": 35, "city": "成都",
     "tags": ["游戏", "动漫"], "bio": "二次元玩家", "prefs": "想找游戏搭子",
     "lat": 30.60, "lng": 104.07, "active_at": "2026-09-06T00:00:00Z"},
    {"id": "test_m2", "name": "同性男", "gender": "m", "age": 30, "city": "杭州",
     "tags": ["徒步"], "bio": "x", "prefs": "x", "lat": 30.25, "lng": 120.15},
]})
check("A2 测试用户批量写入", code == 200 and d.get("ok"), str(d))

# A3 发现：硬筛（同性不出现）+ 排序（近距高契合排第一）
code, d = req(f"{MC}/discover/test_m1?top_n=20")
items = d.get("items", [])
ids = [i["id"] for i in items]
scores = [i["score"] for i in items]
check("A3 发现接口返回结果", code == 200 and len(items) >= 2, f"items={len(items)}")
check("A4 硬筛：结果中无同性", "test_m2" not in ids, f"ids={ids[:6]}")
check("A5 排序：分数降序", scores == sorted(scores, reverse=True), str(scores[:5]))
check("A6 排序：同城高契合的近距女排第一", items and items[0]["id"] == "test_f1",
      f"top1={items[0]['id'] if items else None}")
f1 = next((i for i in items if i["id"] == "test_f1"), {})
f2 = next((i for i in items if i["id"] == "test_f2"), {})
check("A7 距离分：近距女分数明显高于远距女", f1.get("score", 0) > f2.get("score", 0) + 10,
      f"f1={f1.get('score')} f2={f2.get('score')}")
check("A8 推荐理由非空", bool(f1.get("reason")), str(f1.get("reason", ""))[:40])
check("A9 破冰话术非空", bool(f1.get("icebreaker")), str(f1.get("icebreaker", ""))[:40])
check("A10 最终分=粗排精排各50%", f1 and abs(f1["score"] - (f1["coarse"] + f1["fine"]) / 2) < 0.3,
      f"score={f1.get('score')} coarse={f1.get('coarse')} fine={f1.get('fine')}")

# A11 未知用户 → 404
code, d = req(f"{MC}/discover/no_such_user")
check("A11 未知用户返回404", code == 404, f"code={code}")

# A12 top_n 限制生效
code, d = req(f"{MC}/discover/test_m1?top_n=1")
check("A12 top_n限制生效", code == 200 and len(d.get("items", [])) <= 1)

print()
print("=" * 60)
print("B. ANL 集成链路（3001）")
print("=" * 60)

# B1 登录演示账号
code, d = req(f"{ANL}/api/auth/verify-otp", "POST", {"phone": "+8613800138000", "code": "123456"})
token = d.get("token", "")
uid = (d.get("user") or {}).get("id", "")
H = {"Authorization": f"Bearer {token}"}
check("B1 演示账号登录", code == 200 and bool(token), f"uid={uid}")
check("B2 演示账号画像完整", (d.get("user") or {}).get("display_name") == "小艾"
      and len((d.get("user") or {}).get("vibe_tags", [])) >= 3)

# B3 智能匹配接口（ANL 转发）
code, d = req(f"{ANL}/api/discovery/matches?top_n=10", headers=H)
items = d.get("items", [])
check("B3 智能匹配接口可用", code == 200 and len(items) >= 3, f"items={len(items)}")
check("B4 结果带完整档案（display_name/tags）", bool(items and items[0].get("display_name")
      and "tags" in items[0]))
check("B5 结果带推荐理由与破冰话术", all(i.get("reason") and i.get("icebreaker") for i in items[:5]))
check("B6 分数降序", [i["score"] for i in items] == sorted([i["score"] for i in items], reverse=True))

# B7 未知用户自动补同步（旧登录态自愈）
tok2 = mint_token("user_selfheal_test")
code, d = req(f"{ANL}/api/discovery/matches?top_n=5", headers={"Authorization": f"Bearer {tok2}"})
check("B7 未知用户自动创建+同步后可匹配", code == 200 and len(d.get("items", [])) >= 3,
      f"code={code} items={len(d.get('items', []))}")

# B8 资料更新后同步到匹配中心（改年龄 27→29 再改回）
code, d = req(f"{ANL}/api/users/{uid}", "PUT", {"age": 29}, H)
check("B8a 更新资料成功", code == 200, str(code))
code, d = req(f"{MC}/users/{uid}")
check("B8b 更新已同步到匹配中心", code == 200 and d.get("age") == 29, f"age={d.get('age')}")
req(f"{ANL}/api/users/{uid}", "PUT", {"age": 27}, H)

# B9 滑卡-配对-聊天链路不受影响
code, d = req(f"{ANL}/api/matches/like", "POST", {"targetUserId": "demo_u16", "direction": "like"}, H)
check("B9a 右滑配对成功", code == 200 and d.get("matched"))
code, d = req(f"{ANL}/api/matches", headers=H)
matches = d if isinstance(d, list) else d.get("items", [])
check("B9b 匹配列表包含对方", code == 200 and any(m["userId"] == "demo_u16" for m in matches))
code, d = req(f"{ANL}/api/messages/send", "POST", {"targetUserId": "demo_u16", "text": "自动化测试消息"}, H)
check("B9c 消息发送成功", code == 200)
code, d = req(f"{ANL}/api/messages/demo_u16", headers=H)
check("B9d 消息历史可读", code == 200 and len(d) >= 1)

print()
print("=" * 60)
print("C. 匹配中心持久化（重启不丢数据）")
print("=" * 60)
print("C1 重启匹配中心...", end=" ")
# 找到 8016 监听进程并结束（netstat/taskkill 原生方式，避免 PowerShell 挂起）
import subprocess
out = subprocess.run(["netstat", "-ano"], capture_output=True).stdout.decode("utf-8", errors="ignore")
pids = {ln.split()[-1] for ln in out.splitlines() if ":8016" in ln and "LISTENING" in ln}
for pid in pids:
    subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
time.sleep(2)
# 以分离进程方式重启匹配中心
DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
logf = open(r"D:\xm\aiyuelao\logs\match-center.log", "ab")
subprocess.Popen(
    [r"D:\xm\aiyuelao\match-center\.venv\Scripts\python.exe", "-m", "uvicorn",
     "main:app", "--host", "127.0.0.1", "--port", "8016"],
    cwd=r"D:\xm\aiyuelao\match-center",
    stdout=logf, stderr=logf,
    creationflags=DETACHED,
)
time.sleep(5)
code, d = req(f"{MC}/health")
check("C1 重启后用户数据仍在（JSON落盘）", code == 200 and d.get("users", 0) >= 18,
      f"users={d.get('users')}")
code, d = req(f"{MC}/discover/test_m1?top_n=3")
check("C2 重启后发现接口正常", code == 200 and len(d.get("items", [])) >= 1)

print()
print("=" * 60)
print("D. Shidduch 匹配管道（8015）")
print("=" * 60)
code, d = req(f"{SHD}/health/ready")
check("D1 Shidduch后端健康", code == 200)
code, d = req(f"{SHD}/api/v1/auth/login", "POST", {"username": "admin", "password": "admin123"})
tok3 = d.get("access_token", "")
check("D2 登录成功", code == 200 and bool(tok3))
H3 = {"Authorization": f"Bearer {tok3}"}
code, d = req(f"{SHD}/api/v1/candidates?page=1&page_size=50", headers=H3)
cands = d.get("items") or []
check("D3 候选人数据在库", code == 200 and len(cands) >= 12, f"candidates={len(cands)}")
code, d = req(f"{SHD}/api/v1/suggestions", headers=H3)
sugs = d.get("items") or []
check("D4 匹配推荐数据在库", code == 200 and len(sugs) >= 10, f"suggestions={len(sugs)}")
if cands:
    cid = cands[0].get("id")
    code, d = req(f"{SHD}/api/v1/match-run", "POST", {"candidate_id": cid, "top_n": 3}, H3)
    check("D5 实时运行一次AI匹配(离线兜底)", code == 200 and d.get("total", 0) >= 1,
          f"total={d.get('total')}")

print()
print("=" * 60)
print("E. 全服务健康")
print("=" * 60)
SERVICES = [
    ("ANL后端", "http://127.0.0.1:3001/api/health"),
    ("ANL前端", "http://127.0.0.1:5176/"),
    ("匹配引擎", "http://127.0.0.1:8014/docs"),
    ("匹配中心", "http://127.0.0.1:8016/health"),
    ("GlowMeet后端", "http://127.0.0.1:8013/health"),
    ("GlowMeet前端", "http://127.0.0.1:3000/"),
    ("Shidduch后端", "http://127.0.0.1:8015/health/ready"),
    ("Shidduch前端", "http://127.0.0.1:5174/"),
    ("wang后端", "http://127.0.0.1:8123/api/health/ok"),
    ("wang前端", "http://127.0.0.1:5175/"),
]
for name, url in SERVICES:
    code = 0
    for attempt in range(3):  # 重试 3 次，排除瞬时抖动/依赖预热
        code, _ = req(url, timeout=10)
        if code == 200:
            break
        time.sleep(3)
    check(f"E {name}", code == 200, f"HTTP {code}" + ("（3次重试后仍失败）" if code != 200 else ""))

print()
print("=" * 60)
print("F. 清理测试用户（保持演示数据干净）")
print("=" * 60)
for tid in ["test_m1", "test_f1", "test_f2", "test_m2", "user_selfheal_test",
            "user_fresh_test", "user_browser_test"]:
    code, _ = req(f"{MC}/users/{tid}", method="DELETE")
    print(f"  删除 {tid}: {'✓' if code == 200 else '跳过'}")

print()
print("=" * 60)
print(f"测试完成：通过 {PASS}，失败 {FAIL}")
print("=" * 60)
sys.exit(0 if FAIL == 0 else 1)
