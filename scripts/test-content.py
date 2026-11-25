"""Exercise real Astro builds in a temporary site. User content is never edited."""
from html.parser import HTMLParser
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
fields = {"journal": "category: travel", "learn": "topic: cpp\nsection: STL", "lab": ""}
lists = {"journal": ["journal", "journal/category/travel"], "learn": ["learn"], "lab": ["lab"]}


def entry(folder, collection, name, extra="", extension="md"):
    file = folder / "src/content" / collection / f"{name}.{extension}"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(f"---\ntitle: {name}\ndescription: 发布流程测试\ndate: 2026-01-01\n"
                    f"{fields[collection]}\n{extra}\n---\n\n## 测试\n\n正文 {name}\n")
    return file


def build(folder):
    subprocess.run([repo / "node_modules/.bin/astro", "build"], cwd=folder, check=True)
    subprocess.run(["python3", repo / "scripts/verify.py"], cwd=folder, check=True)


class ShareImage(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("property") == "og:image":
            self.url = attrs["content"]


with tempfile.TemporaryDirectory(prefix="hikari-content-") as temp:
    folder = Path(temp)
    for file in ["package.json", "tsconfig.json", "astro.config.mjs"]:
        shutil.copy(repo / file, folder / file)
    shutil.copytree(repo / "src", folder / "src", ignore=shutil.ignore_patterns("content"))
    shutil.copytree(repo / "public", folder / "public")
    (folder / "scripts").mkdir()
    for file in ["study-pwa.mjs", "study-worker.js"]:
        shutil.copy(repo / "scripts" / file, folder / "scripts" / file)
    os.symlink(repo / "node_modules", folder / "node_modules", target_is_directory=True)
    for collection in fields:
        entry(folder, collection, f"draft-{collection}", "draft: true", "mdx" if collection == "lab" else "md")
        entry(folder, collection, f"demo-{collection}", "demo: true")

    build(folder)
    dist = folder / "dist"
    def page(route):
        return (dist / route / "index.html").read_text()

    home = page("")
    assert "第一篇正式内容发布后" in home
    for collection, sections in lists.items():
        demo = f"demo-{collection}"
        assert "Demo" in page(f"{collection}/{demo}") and demo not in home
        for section in sections:
            assert demo in page(section) and "Demo" in page(section)
        assert not (dist / collection / f"draft-{collection}").exists()
    for file in [*dist.rglob("*.html"), *dist.glob("*.xml")]:
        assert not any(f"draft-{key}" in file.read_text() for key in fields), file

    # Distinct local image exercises the relative cover path and social card override.
    shutil.copy(repo / "docs/home-preview.jpg", folder / "src/content/journal/test-cover.jpg")
    for collection in fields:
        extra = "cover:\n  src: ./test-cover.jpg\n  alt: 测试封面" if collection == "journal" else ""
        entry(folder, collection, f"published-{collection}", extra, "mdx" if collection == "lab" else "md")
    build(folder)
    for collection, sections in lists.items():
        name = f"published-{collection}"
        assert name in page("") and all(name in page(section) for section in sections)
        assert f"/{collection}/{name}/" in (dist / "sitemap-0.xml").read_text()
    card = ShareImage()
    card.feed(page(""))
    default = card.url
    card.feed(page("journal/published-journal"))
    assert card.url != default and "测试封面" in page("journal/published-journal")
    print("Draft, Demo, empty state, publishing, categories and custom cover verified.")

    entry(folder, "journal", "conflict-check", "slug: category/travel")
    conflict = subprocess.run([repo / "node_modules/.bin/astro", "build"], cwd=folder,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert conflict.returncode and "category/travel" in conflict.stdout, conflict.stdout
    print("Conflicting journal/category/travel publication correctly rejected.")
