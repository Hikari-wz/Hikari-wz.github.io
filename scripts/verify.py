"""Check the static output exactly as a root-hosted Pages site."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit
from xml.etree import ElementTree

root = Path("dist")
site = "https://hikari.wang"


class Document(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.ids = set()
        self.links = []
        self.h1_count = 0
        self.main_count = 0
        self.meta = {}
        self.canonical = None
        self.path = path
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            assert attrs["id"] not in self.ids, f"{self.path}: duplicate id {attrs['id']}"
            self.ids.add(attrs["id"])
        if tag == "main":
            self.main_count += 1
        if tag == "html":
            assert attrs.get("lang"), f"{self.path}: missing language"
        if tag == "img":
            assert "alt" in attrs, f"{self.path}: missing alt"
        if tag == "meta":
            self.meta[attrs.get("name") or attrs.get("property")] = attrs.get("content")
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonical = attrs.get("href")
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
indexable = set()
for path, page in pages.items():
    assert page.h1_count == 1, f"Expected one h1 in {path}"
    url = site + "/" + path.relative_to(root).as_posix().removesuffix("index.html")
    assert page.main_count == 1 and "#main" in page.links, f"{path}: missing main landmark or skip link"
    if page.meta.get("robots") != "noindex":
        assert page.canonical == url or unquote(page.canonical or "") == url, f"{path}: incorrect canonical"
        assert unquote(page.meta.get("og:url", "")) == url, path
        indexable.add(unquote(url))
    for key in ("og:title", "og:description", "og:image:alt", "twitter:title", "twitter:description", "twitter:image:alt"):
        assert page.meta.get(key), f"{path}: missing {key}"
    assert page.meta.get("twitter:card") == "summary_large_image", path
    image = page.meta.get("og:image", "")
    assert image.startswith(site + "/") and page.meta.get("twitter:image") == image, path
    assert destination(urlsplit(image).path).is_file(), f"{path}: missing social image"
    for ref in page.links:
        target = urlsplit(urljoin(url, ref))
        if target.netloc != urlsplit(site).netloc or target.scheme not in ("http", "https"):
            continue
        dest = destination(target.path)
        assert dest.is_file(), f"{path} -> {ref} missing"
        if target.fragment and dest in pages:
            assert unquote(target.fragment) in pages[dest].ids, f"{path} -> {ref} missing anchor"
        total += 1
assert "Sitemap: " + site + "/sitemap-index.xml" in (root / "robots.txt").read_text()
listed = set()
for xml in root.glob("sitemap*.xml"):
    for loc in ElementTree.parse(xml).iterfind(".//{*}loc"):
        url = urlsplit(loc.text)
        if xml.name != "sitemap-index.xml":
            listed.add(unquote(loc.text))
        assert url.netloc == urlsplit(site).netloc and destination(url.path).is_file(), loc.text
assert listed == indexable, f"Sitemap mismatch: {listed ^ indexable}"
print(f"Verified {len(pages)} HTML pages and {total} internal references.")
