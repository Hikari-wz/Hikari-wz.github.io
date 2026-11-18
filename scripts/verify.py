"""Check the static output exactly as a root-hosted Pages site."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit
from xml.etree import ElementTree

root = Path("dist")
site = "https://hikari-wz.github.io"


class Document(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.ids = set()
        self.links = []
        self.h1_count = 0
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        if tag == "h1":
            self.h1_count += 1
        for name in ("href", "src"):
            if attrs.get(name):
                self.links.append(attrs[name])
        if attrs.get("srcset"):
            self.links.extend(item.split()[0] for item in attrs["srcset"].split(","))


def destination(pathname):
    dest = root / unquote(pathname).lstrip("/")
    return dest / "index.html" if dest.is_dir() else dest


required = ["/", "/journal/", "/learn/", "/lab/", "/desk/", "/about/", "/404.html"]
for route in required + ["/robots.txt", "/sitemap-index.xml"]:
    assert destination(route).is_file(), f"Missing {route}"

pages = {path: Document(path) for path in root.rglob("*.html")}
total = 0
for path, page in pages.items():
    assert page.h1_count == 1, f"Expected one h1 in {path}"
    url = site + "/" + path.relative_to(root).as_posix().removesuffix("index.html")
    for ref in page.links:
        target = urlsplit(urljoin(url, ref))
        if target.netloc != urlsplit(site).netloc or target.scheme not in ("http", "https"):
            continue
        dest = destination(target.path)
        assert dest.is_file(), f"{path} -> {ref} missing"
        if target.fragment and dest in pages:
            assert unquote(target.fragment) in pages[dest].ids, f"{path} -> {ref} missing anchor"
        total += 1
for xml in root.glob("sitemap*.xml"):
    for loc in ElementTree.parse(xml).iterfind(".//{*}loc"):
        url = urlsplit(loc.text)
        assert url.netloc == urlsplit(site).netloc and destination(url.path).is_file(), loc.text
print(f"Verified {len(pages)} HTML pages and {total} internal references.")
