"""
one-shot-backfill.py — Windows 一键 backfill
在 Windows 上跑 (PowerShell):
  cd D:\aicg1.0\data
  python D:\你的路径\scripts\sql\one-shot-backfill.py --db huobao_drama.db
"""
import argparse
import json
import re
import sqlite3
import sys

OUTPUTS_RE = re.compile(r"^\s*✓\s+(.+?):\s+(\S+)\s*$")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=r"D:\aicg1.0\data\huobao_drama.db",
                    help="Windows 本地 DB 路径")
    args = ap.parse_args()

    print(f"[1/3] 连接 {args.db}")
    conn = sqlite3.connect(args.db, timeout=30)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(cron_runs)").fetchall()]
    if "outputs" not in cols:
        print("  -> outputs 列不在, ALTER TABLE 加列")
        conn.execute("ALTER TABLE cron_runs ADD COLUMN outputs TEXT")
        conn.commit()
    else:
        print("  -> outputs 列已存在, skip ALTER")

    print(f"[2/3] backfill 老数据")
    rows = conn.execute("""
        SELECT id, name, output FROM cron_runs
        WHERE outputs IS NULL AND output IS NOT NULL
    """).fetchall()
    updated, skipped = 0, 0
    for row_id, name, output in rows:
        paths = []
        for line in (output or "").splitlines():
            m = OUTPUTS_RE.match(line)
            if m and m.group(2).strip().rstrip(".,;:").startswith("/"):
                paths.append(m.group(2).strip().rstrip(".,;:"))
        # 去重保序
        seen, unique = set(), []
        for p in paths:
            if p not in seen:
                seen.add(p); unique.append(p)
        if not unique:
            skipped += 1; continue
        conn.execute("UPDATE cron_runs SET outputs = ? WHERE id = ?",
                     (json.dumps(unique, ensure_ascii=False), row_id))
        updated += 1
    conn.commit()

    print(f"  -> 更新 {updated} 行, 跳过 (无 ✓ 路径) {skipped} 行")

    print(f"[3/3] 验证")
    total = conn.execute("SELECT COUNT(*) FROM cron_runs").fetchone()[0]
    has = conn.execute("SELECT COUNT(*) FROM cron_runs WHERE outputs IS NOT NULL AND outputs != '[]'").fetchone()[0]
    print(f"  total = {total}, 有 outputs = {has}")
    print(f"  样本 3 条 (新填的 outputs):")
    for row in conn.execute("SELECT name, substr(outputs, 1, 100) FROM cron_runs WHERE outputs IS NOT NULL LIMIT 3").fetchall():
        print(f"    {row[0]}: {row[1]}")
    conn.close()

if __name__ == "__main__":
    main()
