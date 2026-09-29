"""
one-shot-backfill.py — Windows 一键 backfill cron_runs.outputs

正确路径 (2026-09-29):
  - Windows 项目根: D:\aicg1.0\huobao-drama-1.0\
  - DB 文件:       D:\aicg1.0\data\huobao_drama.db
  - 本脚本路径:     D:\aicg1.0\huobao-drama-1.0\scripts\sql\one-shot-backfill.py

用法 (PowerShell, 必须先停 backend 避免 SQLite 锁冲突):
  docker stop huobao-drama-1.0
  cd D:\aicg1.0\data
  python -u D:\aicg1.0\huobao-drama-1.0\scripts\sql\one-shot-backfill.py --db huobao_drama.db
  docker start huobao-drama-1.0

路径记忆:
  - Mac 看的是 SMB 挂载:  /Volumes/aicg1.0/data/huobao_drama.db
  - 后端 Docker 看的是:   /app/data/huobao_drama.db (volume 映射 D:/aicg1.0/data)
  - Windows 看的是:        D:\aicg1.0\data\huobao_drama.db
  - 三者是同一文件 (Windows 通过 Docker volume 把 D:\aicg1.0\data 挂到容器的 /app/data)

v2 改进:
- 加 sys.stdout.reconfigure(encoding="utf-8") 处理 Windows 中文编码
- 加 flush=True 让 PowerShell 不缓冲
- 加 try/except + traceback, 出错也能看到
"""
import argparse
import json
import re
import sys
import traceback

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

OUTPUTS_RE = re.compile(r"^\s*✓\s+(.+?):\s+(\S+)\s*$")


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> int:
    try:
        ap = argparse.ArgumentParser()
        ap.add_argument("--db", default=r"D:\aicg1.0\data\huobao_drama.db",
                        help="Windows 本地 DB 路径 (默认 D:\\aicg1.0\\data\\huobao_drama.db)")
        args = ap.parse_args()

        log(f"[1/3] 连接 {args.db}")

        import sqlite3
        conn = sqlite3.connect(args.db, timeout=30)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(cron_runs)").fetchall()]
        if "outputs" not in cols:
            log("  -> outputs 列不在, ALTER TABLE 加列")
            conn.execute("ALTER TABLE cron_runs ADD COLUMN outputs TEXT")
            conn.commit()
            log("  -> ALTER 完成")
        else:
            log("  -> outputs 列已存在, skip ALTER")

        log("[2/3] backfill 老数据")
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
        log(f"  -> 更新 {updated} 行, 跳过 (无 ✓ 路径) {skipped} 行")

        log("[3/3] 验证")
        total = conn.execute("SELECT COUNT(*) FROM cron_runs").fetchone()[0]
        has = conn.execute("SELECT COUNT(*) FROM cron_runs WHERE outputs IS NOT NULL AND outputs != '[]'").fetchone()[0]
        log(f"  total = {total}, 有 outputs = {has}")
        if has > 0:
            log("  样本 3 条 (新填的 outputs):")
            for row in conn.execute("SELECT name, substr(outputs, 1, 100) FROM cron_runs WHERE outputs IS NOT NULL LIMIT 3").fetchall():
                log(f"    {row[0]}: {row[1]}")
        conn.close()
        log("\n✅ 完成")
        return 0
    except Exception as e:
        log(f"\n❌ 错误: {e}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
