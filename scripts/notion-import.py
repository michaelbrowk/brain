#!/usr/bin/env python3
"""Two-pass, idempotent Notion-export -> Brain importer.

Pass 1: create a page (folder + index.md) for every Notion .md, mirroring the
        export's folder nesting; record hex(notionId) -> new page id.
Pass 2: rewrite inline links to /p/<id>, copy images to _attachments.

Dry-run prints the plan and writes nothing.
"""
import argparse, os, re, sys, json, hashlib, secrets, string, shutil, urllib.parse
from pathlib import Path

HEX = re.compile(r"^(?P<name>.+?) (?P<hex>[0-9a-f]{32})\.md$")
NANO = string.ascii_letters + string.digits + "_-"
# leading emoji (rough: most pictographic ranges)
EMOJI = re.compile(
    "^([\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002190-\U000021FF\U00002B00-\U00002BFF️‍]+)\s*"
)

def nanoid(n=12):
    return "".join(secrets.choice(NANO) for _ in range(n))

def split_name(fname):
    m = HEX.match(fname)
    if not m:
        return None, None
    return m.group("name"), m.group("hex")

def extract_emoji(title):
    m = EMOJI.match(title)
    if m:
        return m.group(1), title[m.end():].strip()
    return None, title

def slugify(title):
    s = re.sub(r"[^\w\s-]", "", title.lower(), flags=re.UNICODE).strip()
    s = re.sub(r"[\s_]+", "-", s)
    return s[:60] or "page"

def match_folder(name, subdirs, used):
    """Notion truncates long folder names; the file keeps the full name.
       Pick the unused subdir that is the longest prefix-match of `name`."""
    best, best_len = None, -1
    for s in subdirs:
        if s in used:
            continue
        # folder is a (possibly truncated) prefix of the page name, or equal
        if name == s or name.startswith(s) or s.startswith(name):
            ln = len(os.path.commonprefix([name, s]))
            if ln > best_len:
                best, best_len = s, ln
    return best

def count_md(dirpath):
    n = 0
    for _, _, fs in os.walk(dirpath):
        n += sum(1 for f in fs if f.endswith(".md") and split_name(f)[1])
    return n

def collect(roots, skip_db_over=0):
    """Recursive top-down walk: a page's children live in the sibling folder
       whose (truncated) name prefix-matches the page name."""
    pages = {}
    skipped_dbs = []

    def descend(dirpath, parent_hex):
        try:
            entries = os.listdir(dirpath)
        except OSError:
            return
        files = []
        for f in entries:
            if f.endswith(".md"):
                name, hexid = split_name(f)
                if hexid:
                    files.append((f, name, hexid))
        subdirs = [d for d in entries if os.path.isdir(os.path.join(dirpath, d))]
        used = set()
        # longer names first so specific pages claim their folder before short ones
        for f, name, hexid in sorted(files, key=lambda x: -len(x[1])):
            icon, clean = extract_emoji(name)
            pages[hexid] = {
                "hex": hexid, "title": clean, "icon": icon,
                "path": Path(dirpath) / f, "dir": Path(dirpath),
                "parent_hex": parent_hex, "id": nanoid(),
            }
            child_folder = match_folder(name, subdirs, used)
            if child_folder:
                used.add(child_folder)
                descend(os.path.join(dirpath, child_folder), hexid)
        # unmatched subdirs = Notion databases (slug-named folders of row-pages);
        # their rows belong to the page that owns THIS folder (parent_hex)
        for d in subdirs:
            if d not in used:
                full = os.path.join(dirpath, d)
                if skip_db_over and count_md(full) > skip_db_over:
                    skipped_dbs.append((d, count_md(full)))
                    continue
                descend(full, parent_hex)

    for root in roots:
        descend(root, None)
    collect.skipped = skipped_dbs
    return pages

def depth_of(p, pages):
    d = 0
    seen = set()
    while p["parent_hex"] and p["parent_hex"] in pages and p["hex"] not in seen:
        seen.add(p["hex"]); p = pages[p["parent_hex"]]; d += 1
    return d

LINK = re.compile(r"\]\(([^)]+?\.md)\)")
IMG = re.compile(r"!\[([^\]]*)\]\(([^)]+?\.(?:png|jpe?g|gif|webp|svg))\)", re.I)
NOTION_URL = re.compile(r"https://www\.notion\.so/[^)\s]*?([0-9a-f]{32})")

def rewrite_body(body, page, pages, assets_out, do_write):
    """Strip leading '# Title', rewrite internal links + images."""
    lines = body.split("\n")
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
        if lines and lines[0] == "":
            lines = lines[1:]
    body = "\n".join(lines)

    stats = {"links": 0, "links_ok": 0, "imgs": 0}

    def link_sub(m):
        stats["links"] += 1
        target = urllib.parse.unquote(m.group(1))
        hm = re.search(r"([0-9a-f]{32})\.md$", target)
        if hm and hm.group(1) in pages:
            stats["links_ok"] += 1
            return f"](/p/{pages[hm.group(1)]['id']})"
        return m.group(0)

    def notion_url_sub(m):
        h = m.group(1)
        if h in pages:
            return f"/p/{pages[h]['id']}"
        return m.group(0)

    def img_sub(m):
        stats["imgs"] += 1
        rel = urllib.parse.unquote(m.group(2))
        src = (page["dir"] / rel).resolve()
        if not src.exists():
            return m.group(0)
        ext = src.suffix.lower().lstrip(".")
        name = f"{nanoid(12)}.{ext}"
        if do_write:
            assets_out.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, assets_out / name)
        return f"![{m.group(1)}](/api/media/{name})"

    body = IMG.sub(img_sub, body)
    body = LINK.sub(link_sub, body)
    body = NOTION_URL.sub(notion_url_sub, body)
    return body, stats

def frontmatter(page, order):
    fm = ["---", f"id: {page['id']}", f'title: "{page["title"].replace(chr(34), "")}"']
    if page["icon"]:
        fm.append(f'icon: "{page["icon"]}"')
    fm.append(f"order: {order}")
    fm.append(f"created: 2026-07-08T00:00:00.000Z")
    fm.append(f"updated: 2026-07-08T00:00:00.000Z")
    fm.append(f"notionId: {page['hex']}")
    fm.append("---")
    return "\n".join(fm)

def target_dir(page, pages, target_root, memo, used_paths):
    if page["hex"] in memo:
        return memo[page["hex"]]
    if page["parent_hex"] and page["parent_hex"] in pages:
        parent_dir = target_dir(pages[page["parent_hex"]], pages, target_root, memo, used_paths)
    else:
        parent_dir = target_root
    d = parent_dir / slugify(page["title"])
    # avoid slug collisions among siblings (compare strings, not Path objects)
    base = d
    n = 2
    while str(d) in used_paths:
        d = Path(str(base) + f"-{n}")
        n += 1
    memo[page["hex"]] = d
    used_paths.add(str(d))
    return d

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roots", nargs="+", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-db-over", type=int, default=0)
    args = ap.parse_args()

    pages = collect(args.roots, skip_db_over=args.skip_db_over)
    target_root = Path(args.target)
    assets_out = target_root / "_attachments"

    # existing notionIds in target (idempotency)
    existing = set()
    if target_root.exists():
        for p in target_root.rglob("index.md"):
            try:
                head = p.read_text(errors="ignore")[:600]
                m = re.search(r"notionId: ([0-9a-f]{32})", head)
                if m: existing.add(m.group(1))
            except Exception: pass

    roots_pages = [p for p in pages.values() if not p["parent_hex"] or p["parent_hex"] not in pages]
    depths = [depth_of(p, pages) for p in pages.values()]
    total_links = total_imgs = links_ok = 0
    # analyze bodies (no write) for link/img stats
    for p in pages.values():
        try:
            body = p["path"].read_text(errors="ignore")
        except Exception:
            body = ""
        _, st = rewrite_body(body, p, pages, assets_out, do_write=False)
        total_links += st["links"]; total_imgs += st["imgs"]; links_ok += st["links_ok"]

    # count csv (databases) near the export
    csvs = 0
    for root in args.roots:
        for _, _, files in os.walk(root):
            csvs += sum(1 for f in files if f.endswith(".csv"))

    print("── Notion import — dry-run plan ─────────────────────")
    print(f"pages found      : {len(pages)}")
    print(f"top-level pages  : {len(roots_pages)}  -> {[p['title'][:34] for p in sorted(roots_pages, key=lambda x:x['title'])][:12]}")
    print(f"max nest depth   : {max(depths) if depths else 0}")
    print(f"already imported : {len(existing & set(pages))}  (idempotent — will skip)")
    print(f"internal links   : {total_links}  ({links_ok} resolve to a page, {total_links-links_ok} external/dangling)")
    print(f"images to copy   : {total_imgs}")
    print(f"databases (.csv) : {csvs}  (row-pages import as normal pages; .csv index skipped)")
    with_icon = sum(1 for p in pages.values() if p["icon"])
    print(f"pages with emoji : {with_icon}")
    for name, n in getattr(collect, "skipped", []):
        print(f"skipped database : {name}  ({n} rows)")

    if args.dry_run:
        print("\n(dry-run — nothing written)")
        return

    # ── real write ──
    memo = {}
    used_paths = set()
    written = skipped = 0
    for p in pages.values():
        d = target_dir(p, pages, target_root, memo, used_paths)
    # order per sibling group
    from collections import defaultdict
    groups = defaultdict(list)
    for p in pages.values():
        groups[p["parent_hex"]].append(p)
    order_of = {}
    for grp in groups.values():
        for i, p in enumerate(sorted(grp, key=lambda x: x["title"].lower())):
            order_of[p["hex"]] = f"a{i:04d}"
    for p in pages.values():
        if p["hex"] in existing:
            skipped += 1; continue
        d = memo[p["hex"]]
        d.mkdir(parents=True, exist_ok=True)
        try:
            body = p["path"].read_text(errors="ignore")
        except Exception:
            body = ""
        body, _ = rewrite_body(body, p, pages, assets_out, do_write=True)
        content = frontmatter(p, order_of.get(p["hex"], "a0")) + "\n\n" + body.strip() + "\n"
        (d / "index.md").write_text(content)
        written += 1
    print(f"\nwritten: {written}  skipped(existing): {skipped}")

if __name__ == "__main__":
    main()
