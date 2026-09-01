from __future__ import annotations

import asyncio
import base64
import socket
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest.mock import AsyncMock, MagicMock, patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from curl_cffi.const import CurlOpt

from apps.scraper.src.service import (
    ScraperError,
    _curl_resolve_entry,
    _dynamic_page,
    _retry_after_seconds,
    configured_scraper_token,
    extract_page,
    normalize_discord,
    normalize_telegram,
    resolve_public_target,
    scrape_url,
    validate_public_url,
)
from scrapling.parser import Selector


def parsed(html: str, url: str = "https://example.com/"):
    return Selector(html, url=url)


FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str):
    return (FIXTURES / name).read_text(encoding="utf-8")


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/slow":
            time.sleep(1.5)
        routes = {
            "/": (200, "text/html", '<title>Home</title><a href="/contact">Contact</a>'),
            "/contact": (200, "text/html", "discord.gg/deep <a href='mailto:hello@example.com'>Email</a>"),
            "/slow": (200, "text/html", "slow"),
            "/403": (403, "text/html", "forbidden"),
            "/404": (404, "text/html", "missing"),
            "/429": (429, "text/html", "limited"),
            "/500": (500, "text/html", "error"),
            "/redirect": (302, "text/html", ""),
            "/discord-redirect": (302, "text/html", "community moved"),
            "/robots.txt": (200, "text/plain", "User-agent: *\nDisallow: /private"),
            "/dynamic": (
                200,
                "text/html",
                '<html><head><title>Dynamic</title></head><body><div id="app"></div>'
                '<script>const parts=["dynamic","discord.gg/","https://"]; parts.reverse();'
                'document.getElementById("app").innerHTML="<a href=\\""+parts.join("")+' 
                '"\\">Discord</a>"</script></body></html>',
            ),
            "/dynamic-popup": (
                200,
                "text/html",
                '<html><body><button id="join"><svg data-icon="discord"></svg></button>'
                '<script>const popupParts=["popup-code","discord.gg/","https://"];'
                'document.getElementById("join").onclick=()=>window.open(popupParts.reverse().join(""));'
                '</script></body></html>',
            ),
            "/dynamic-scroll-popup": (
                200,
                "text/html",
                '<html><body><div style="height:3000px">Scroll</div>'
                '<script>window.addEventListener("scroll",()=>{if(document.getElementById("late"))return;'
                'const footer=document.createElement("div");footer.className="site-bottom";const b=document.createElement("a");b.id="late";'
                'const img=document.createElement("img");img.src="/community-banner.png";b.appendChild(img);footer.appendChild(b);document.body.appendChild(footer);'
                'b.addEventListener("click",()=>window.open(["late-code","discord.gg/","https://"].reverse().join("")));'
                '},{once:true});</script></body></html>',
            ),
            "/dynamic-nfa": (
                200,
                "text/html",
                '<html><head><title>Rust NFA Accounts</title></head><body><h1>Rust NFA Accounts</h1>'
                '<div style="height:3000px">Public variants</div><div id="variants"></div>'
                '<script>window.addEventListener("scroll",()=>{document.getElementById("variants").innerHTML='
                '"<label>Premium, Inactive 15 Days <span class=\\"price\\">$4.10</span></label>";},{once:true});'
                '</script></body></html>',
            ),
        }
        status, content_type, body = routes.get(self.path, (404, "text/html", "missing"))
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if self.path == "/redirect":
            self.send_header("Location", "/contact")
        if self.path == "/discord-redirect":
            self.send_header("Location", "https://discord.gg/location-code")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *_args):
        pass


class ExtractionTests(unittest.TestCase):
    def test_retry_after_supports_seconds_and_http_dates(self):
        self.assertEqual(_retry_after_seconds({"retry-after": "12"}), 12)
        future = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=60))
        parsed_delay = _retry_after_seconds({"retry-after": future})
        self.assertIsNotNone(parsed_delay)
        self.assertGreaterEqual(parsed_delay, 55)
        self.assertLessEqual(parsed_delay, 60)
        self.assertIsNone(_retry_after_seconds({"retry-after": "invalid"}))

    def test_dns_pin_entries_preserve_hostname_and_port(self):
        self.assertEqual(
            _curl_resolve_entry(
                "https://example.com/contact",
                ["1.1.1.1", "2606:4700:4700::1111"],
            ),
            "example.com:443:1.1.1.1,[2606:4700:4700::1111]",
        )

    def test_public_dns_results_are_reused_for_repeated_same_host_pages(self):
        records = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
        ]
        with patch("apps.scraper.src.service.socket.getaddrinfo", return_value=records) as lookup:
            first = resolve_public_target("https://scanner-cache-test.invalid/")
            second = resolve_public_target("https://scanner-cache-test.invalid/contact")

        self.assertEqual(first[1], ["1.1.1.1"])
        self.assertEqual(second[1], ["1.1.1.1"])
        self.assertEqual(lookup.call_count, 1)

    def test_dynamic_fetch_uses_one_bounded_browser_attempt(self):
        captured = {}

        class FakeFetcher:
            @staticmethod
            async def async_fetch(_url, **kwargs):
                captured.update(kwargs)
                return object()

        with patch(
            "apps.scraper.src.service._load_dynamic_fetcher",
            return_value=FakeFetcher,
        ):
            asyncio.run(
                _dynamic_page(
                    "https://example.com/",
                    1_000,
                    allow_private=False,
                    pinned_addresses=["93.184.216.34"],
                )
            )
        self.assertEqual(captured["retries"], 1)

    def test_production_worker_requires_a_unique_strong_token(self):
        with patch.dict("os.environ", {"NODE_ENV": "production"}, clear=True):
            with self.assertRaises(ScraperError):
                configured_scraper_token()
        with patch.dict(
            "os.environ",
            {
                "NODE_ENV": "production",
                "SCRAPER_TOKEN": "production-scraper-secret-123456789",
            },
            clear=True,
        ):
            self.assertEqual(
                configured_scraper_token(),
                "production-scraper-secret-123456789",
            )

    def test_static_fetch_is_pinned_to_the_validated_dns_answer(self):
        page = parsed("<html><title>Pinned</title></html>", "https://example.com/")
        page.status = 200
        page.headers = {"content-type": "text/html"}
        dns_answer = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))
        ]
        response = MagicMock()
        response.url = "https://example.com/"
        response.content = b"<html><title>Pinned</title></html>"
        response.status_code = 200
        response.reason = "OK"
        response.encoding = "utf-8"
        response.cookies = {}
        response.headers = {"content-type": "text/html"}
        response.request = None
        response.history = []
        session = MagicMock()
        session.get = AsyncMock(return_value=response)
        session.close = AsyncMock()
        session_factory = MagicMock(return_value=session)
        with (
            patch("apps.scraper.src.service.socket.getaddrinfo", return_value=dns_answer),
            patch("apps.scraper.src.service.CurlAsyncSession", session_factory),
        ):
            result = asyncio.run(
                scrape_url(
                    "https://example.com/",
                    dynamic_fallback=False,
                )
            )
        self.assertEqual(result["title"], "Pinned")
        curl_options = session_factory.call_args.kwargs["curl_options"]
        self.assertEqual(
            curl_options[CurlOpt.RESOLVE],
            ["example.com:443:93.184.216.34"],
        )
        self.assertNotIn("curl_options", session.get.await_args.kwargs)
        session.close.assert_awaited_once()

    def test_static_contact_and_metadata_extraction(self):
        html = """<html><head><title>Acme</title><meta name="description" content="Widgets">
        <link rel="canonical" href="/home"><link rel="icon" href="/favicon.ico"></head><body>
        <a href="https://discord.gg/example">Discord</a> contact@acme.example
        <a href="https://t.me/acme">Telegram</a><a href="/contact">Contact</a></body></html>"""
        result = extract_page(parsed(html), "https://example.com/", fetch_mode="HTTP", duration_ms=4)
        self.assertEqual(result["title"], "Acme")
        self.assertEqual(result["metaDescription"], "Widgets")
        self.assertEqual(result["discordLinks"], ["https://discord.gg/example"])
        self.assertEqual(result["discordDetections"][0]["method"], "anchor")
        self.assertIn("contact@acme.example", result["emails"])
        self.assertEqual(result["socialLinks"][0]["type"], "telegram")
        self.assertIn("https://example.com/contact", result["internalLinks"])

    def test_telegram_variants_are_normalized_from_links_text_and_embedded_data(self):
        html = """<html><body>
        <a href="https://telegram.me/AcmeSupport">Telegram</a>
        <span>Backup: t.me/+Invite_Code.</span>
        <script>window.contact = "https:\\/\\/telegram.dog\\/AcmeDog";</script>
        <div data-link="https://web.telegram.org/k/#@acme"></div>
        <p>News https://telegram.org/blog/acme</p>
        </body></html>"""
        result = extract_page(parsed(html), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        urls = {link["url"] for link in result["socialLinks"] if link["type"] == "telegram"}
        self.assertEqual(
            urls,
            {
                "https://t.me/AcmeSupport",
                "https://t.me/+Invite_Code",
                "https://t.me/AcmeDog",
                "https://web.telegram.org/k#@acme",
                "https://telegram.org/blog/acme",
            },
        )
        self.assertEqual(normalize_telegram("telegram.me/AcmeSupport"), "https://t.me/AcmeSupport")
        self.assertIsNone(normalize_telegram("https://telegram.org"))

    def test_rust_nfa_screenshot_variants_are_separate_and_clean(self):
        result = extract_page(
            parsed(fixture("rust-nfa-variants.html"), "https://example.com/rust-nfa"),
            "https://example.com/rust-nfa",
            fetch_mode="HTTP",
            duration_ms=2,
        )
        listings = result["rustPriceListings"]
        self.assertEqual(len(listings), 20)
        self.assertEqual(len({item["name"] for item in listings}), 20)
        self.assertEqual({item["link"] for item in listings}, {"https://example.com/rust-nfa"})
        by_name = {item["name"]: item for item in listings}
        self.assertEqual(by_name["500-1000 Hours"]["priceText"], "$1.70")
        self.assertEqual(by_name["Premium, $100+ Inventory"]["priceText"], "$3.10")
        self.assertTrue(all("Out of Stock" not in item["name"] and "Unavailable" not in item["name"] for item in listings))
        self.assertTrue(all(set(item) == {"name", "priceMinor", "currency", "priceText", "link", "method"} for item in listings))

    def test_generalized_rust_nfa_controls_are_extracted(self):
        result = extract_page(
            parsed(fixture("rust-nfa-generalized.html")),
            "https://example.com/rust-nfa-generalized",
            fetch_mode="HTTP",
            duration_ms=1,
        )
        names = {item["name"] for item in result["rustPriceListings"]}
        self.assertEqual(len(names), 9)
        self.assertIn("Rust NFA 100-300 Hours", names)
        self.assertIn("NFA Inactive 30 Days", names)
        self.assertIn("Rust NFA $200+ Inventory", names)
        inventory = next(item for item in result["rustPriceListings"] if item["name"] == "Rust NFA $200+ Inventory")
        self.assertEqual(inventory["priceText"], "$3.25")

    def test_unrelated_prices_are_not_treated_as_rust_accounts(self):
        result = extract_page(
            parsed('<article><h2>Rust game server hosting</h2><span class="price">$9.99</span></article>'),
            "https://example.com/hosting",
            fetch_mode="HTTP",
            duration_ms=1,
        )
        self.assertEqual(result["rustPriceListings"], [])

    def test_generic_game_account_product_is_extracted_when_requested(self):
        html = """<html><head><title>Fortnite Accounts Marketplace</title></head><body>
        <article data-product-id="fortnite-elite"><h2>Fortnite Elite Account</h2>
        <a href="/fortnite-elite">View account</a><span class="price">$24.95</span></article>
        <article><h2>Unrelated hosting plan</h2><span class="price">$8.00</span></article>
        </body></html>"""
        result = extract_page(
            parsed(html),
            "https://example.com/accounts",
            fetch_mode="HTTP",
            duration_ms=1,
            product_name="Fortnite accounts",
            product_type="GAME_ACCOUNTS",
        )
        listings = result["rustPriceListings"]
        self.assertTrue(any(item["name"] == "Fortnite Elite Account" for item in listings))
        self.assertFalse(any("hosting" in item["name"].lower() for item in listings))

    def test_discord_plain_text_and_href_are_normalized_and_deduplicated(self):
        html = '<a href="http://discord.com/invite/example">Chat</a> Join discord.gg/example'
        result = extract_page(parsed(html), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        self.assertEqual(result["discordLinks"], ["https://discord.gg/example"])
        self.assertEqual(normalize_discord("discord.com/invite/Test"), "https://discord.gg/Test")
        self.assertEqual(
            normalize_discord(r"https%3A%2F%2F\u0064iscord.gg%2FEncoded"),
            "https://discord.gg/Encoded",
        )
        self.assertEqual(
            normalize_discord("https://discord.com/servers/example-community-123456789"),
            "https://discord.com/servers/example-community-123456789",
        )

    def test_discovery_methods_cover_footer_json_and_data_attributes(self):
        cases = [
            ("discord-in-footer.html", "https://discord.gg/footer-code", "anchor"),
            ("discord-in-json-data.html", "https://discord.gg/json-code", "embedded-data"),
            ("discord-in-data-url.html", "https://discord.gg/data-code", "data-attribute"),
        ]
        for name, url, method in cases:
            with self.subTest(name=name):
                result = extract_page(parsed(fixture(name)), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
                self.assertIn(url, result["discordLinks"])
                self.assertTrue(
                    any(
                        hit["url"] == url and hit["method"] == method
                        for hit in result["discordDetections"]
                    )
                )

    def test_generalized_icon_raw_json_and_hydration_fixtures(self):
        cases = [
            ("discord-anchor-text.html", "https://discord.gg/anchor-code", "anchor"),
            ("discord-icon-only.html", "https://discord.gg/icon-code", "icon-anchor"),
            ("discord-svg-anchor.html", "https://discord.com/channels/123456789/987654321", "icon-anchor"),
            ("discord-data-url.html", "https://discord.gg/data-url-code", "data-attribute"),
            ("discord-raw-text.html", "https://discord.gg/raw-code", "embedded-data"),
            ("discord-json.html", "https://discord.gg/json-v2", "embedded-data"),
            ("discord-hydration.html", "https://discord.gg/hydration-code", "embedded-data"),
        ]
        for name, url, method in cases:
            with self.subTest(name=name):
                result = extract_page(parsed(fixture(name)), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
                self.assertTrue(
                    any(
                        hit["url"] == url and hit["method"] == method
                        for hit in result["discordDetections"]
                    )
                )

    def test_full_page_button_icon_and_accessibility_fixtures(self):
        cases = [
            ("discord-image-only.html", "https://discord.gg/image-code", "icon-anchor"),
            ("discord-css-background.html", "https://discord.gg/css-code", "icon-anchor"),
            ("discord-in-header.html", "https://discord.gg/header-code", "icon-anchor"),
            ("discord-in-faq.html", "https://discord.gg/faq-code", "anchor"),
            ("discord-midpage-cta.html", "https://discord.gg/midpage-code", "anchor"),
            ("discord-below-fold.html", "https://discord.gg/below-code", "anchor"),
            ("discord-onclick.html", "https://discord.gg/onclick-code", "onclick-attribute"),
            ("discord-formaction.html", "https://discord.gg/form-code", "data-attribute"),
            ("discord-expandable-menu.html", "https://discord.gg/menu-code", "icon-anchor"),
            ("discord-modal.html", "https://discord.gg/modal-code", "anchor"),
            ("discord-floating-widget.html", "https://discord.gg/floating-code", "icon-anchor"),
            ("discord-new-tab.html", "https://discord.gg/new-tab-code", "anchor"),
            ("discord-accessibility-label.html", "https://discord.gg/a11y-code", "icon-anchor"),
        ]
        for name, url, method in cases:
            with self.subTest(name=name):
                result = extract_page(
                    parsed(fixture(name)),
                    "https://example.com/",
                    fetch_mode="HTTP",
                    duration_ms=1,
                )
                self.assertTrue(
                    any(
                        hit["url"] == url and hit["method"] == method
                        for hit in result["discordDetections"]
                    )
                )

    def test_visual_candidate_without_destination_does_not_invent_an_invite(self):
        result = extract_page(
            parsed(fixture("visual-candidate-no-destination.html")),
            "https://example.com/",
            fetch_mode="HTTP",
            duration_ms=1,
        )
        self.assertEqual(result["discordLinks"], [])

    def test_priority_pages_sort_ahead_of_unrelated_internal_links(self):
        for name, expected in (
            ("discord-contact-page.html", "https://example.com/contact-us"),
            ("discord-community-page.html", "https://example.com/community"),
        ):
            with self.subTest(name=name):
                result = extract_page(parsed(fixture(name)), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
                self.assertEqual(result["internalLinks"][0], expected)

    def test_anchor_text_prioritizes_a_generic_same_site_destination(self):
        html = '<a href="/go/community-chat"><svg></svg><span>Discord</span></a><a href="/products/one">Product</a>'
        result = extract_page(parsed(html), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        self.assertEqual(result["priorityLinks"], ["https://example.com/go/community-chat"])

    def test_explicit_discord_route_sorts_ahead_of_other_priority_pages(self):
        html = (
            '<a href="/about-us">About</a><a href="/contact">Contact</a>'
            '<a href="/discord/invite/general"><svg class="discord"></svg></a>'
        )
        result = extract_page(parsed(html), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        self.assertEqual(result["priorityLinks"][0], "https://example.com/discord/invite/general")

    def test_static_navigation_targets_are_queued_without_executing_code(self):
        html = """
        <meta http-equiv="refresh" content="0; url=/community/join">
        <button data-url="/discord/invite/general">Join</button>
        <script>window.location.assign('/socials')</script>
        """
        result = extract_page(parsed(html), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        self.assertEqual(result["priorityLinks"][0], "https://example.com/discord/invite/general")
        self.assertIn("https://example.com/community/join", result["priorityLinks"])
        self.assertIn("https://example.com/socials", result["priorityLinks"])

    def test_bounded_base64_and_concatenated_script_discovery(self):
        encoded = base64.b64encode(b"https://discord.gg/base64-code").decode()
        html = (
            f'<script>const packed = "{encoded}"; '
            "const joined = 'https://dis' + 'cord.gg/concat-code';</script>"
        )
        result = extract_page(parsed(html), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        self.assertIn("https://discord.gg/base64-code", result["discordLinks"])
        self.assertIn("https://discord.gg/concat-code", result["discordLinks"])

    def test_sitemap_locations_become_prioritized_same_site_candidates(self):
        xml = """<?xml version="1.0"?><urlset>
        <url><loc>https://example.com/products/one</loc></url>
        <url><loc>https://example.com/community/discord</loc></url>
        <url><loc>https://outside.example/discord</loc></url>
        </urlset>"""
        result = extract_page(parsed(xml, "https://example.com/sitemap.xml"), "https://example.com/sitemap.xml", fetch_mode="HTTP", duration_ms=1)
        self.assertEqual(result["priorityLinks"], ["https://example.com/community/discord"])
        self.assertNotIn("https://outside.example/discord", result["internalLinks"])

    def test_framework_fixture_requests_controlled_dynamic_fallback(self):
        result = extract_page(parsed(fixture("discord-dynamic.html")), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        self.assertTrue(result["looksDynamic"])

    def test_channel_destinations_are_normalized_without_visible_text(self):
        self.assertEqual(
            normalize_discord("https://discord.com/channels/1257715134986584217/1257715134986584220?ref=site"),
            "https://discord.com/channels/1257715134986584217/1257715134986584220",
        )

    def test_explicit_discord_root_anchor_is_preserved_as_unvalidated_destination(self):
        result = extract_page(
            parsed('<a href="https://discord.gg" aria-label="Discord"></a>'),
            "https://example.com/",
            fetch_mode="HTTP",
            duration_ms=1,
        )
        self.assertEqual(result["discordLinks"], ["https://discord.gg/"])
        self.assertIsNone(normalize_discord("discord.gg"))

    def test_discord_labeled_external_landing_page_is_a_controlled_social_hop(self):
        html = '<a href="https://brand.example/community/discord"><svg class="discord"></svg>Join the server</a>'
        result = extract_page(
            parsed(html),
            "https://example.com/",
            fetch_mode="HTTP",
            duration_ms=1,
        )
        self.assertEqual(
            result["socialLinks"],
            [{
                "type": "discord-landing",
                "url": "https://brand.example/community/discord",
                "sourcePage": "https://example.com/",
            }],
        )

    def test_discord_branded_redirect_image_is_a_controlled_social_hop(self):
        html = (
            '<a href="http://discord.brand.example/">'
            '<img src="/assets/discord-support.jpg" alt=""></a>'
        )
        result = extract_page(
            parsed(html),
            "https://example.com/",
            fetch_mode="HTTP",
            duration_ms=1,
        )
        self.assertEqual(
            result["socialLinks"],
            [{
                "type": "discord-landing",
                "url": "http://discord.brand.example/",
                "sourcePage": "https://example.com/",
            }],
        )

    def test_soft_404_is_reported_separately_from_http_status(self):
        result = extract_page(parsed(fixture("soft-404.html")), "https://example.com/missing", fetch_mode="HTTP", duration_ms=1)
        self.assertTrue(result["isSoft404"])

    def test_supported_link_aggregator_is_classified_for_one_hop_recovery(self):
        result = extract_page(parsed(fixture("social-aggregator.html")), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        self.assertEqual(result["socialLinks"][0]["type"], "linktree")

    def test_cross_domain_is_recorded_as_social_but_not_crawled(self):
        html = '<a href="https://external.example/page">Outside</a><a href="https://x.com/acme">X</a>'
        result = extract_page(parsed(html), "https://example.com/", fetch_mode="HTTP", duration_ms=1)
        self.assertNotIn("https://external.example/page", result["internalLinks"])
        self.assertEqual(result["socialLinks"][0]["type"], "twitter")

    def test_private_targets_are_rejected_by_worker_defense(self):
        for value in ("http://127.0.0.1", "http://localhost", "http://10.0.0.1", "http://192.168.1.1", "http://[::1]"):
            with self.assertRaises(Exception):
                validate_public_url(value)


class FetcherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_async_fetcher_and_manual_redirect(self):
        result = asyncio.run(scrape_url(f"{self.base}/redirect", allow_private=True, dynamic_fallback=False))
        self.assertEqual(result["httpStatus"], 302)
        self.assertEqual(result["redirectUrl"], f"{self.base}/contact")

    def test_discord_redirect_location_is_extracted_without_following_it(self):
        result = asyncio.run(
            scrape_url(
                f"{self.base}/discord-redirect",
                allow_private=True,
                dynamic_fallback=False,
            )
        )
        self.assertEqual(result["discordLinks"], ["https://discord.gg/location-code"])
        self.assertEqual(
            result["discordDetections"],
            [{"url": "https://discord.gg/location-code", "method": "redirect-location"}],
        )

    def test_controlled_static_page(self):
        result = asyncio.run(scrape_url(f"{self.base}/contact", allow_private=True, dynamic_fallback=False))
        self.assertEqual(result["discordLinks"], ["https://discord.gg/deep"])
        self.assertEqual(result["emails"], ["hello@example.com"])

    def test_robots_resource(self):
        result = asyncio.run(scrape_url(f"{self.base}/robots.txt", allow_private=True, mode="robots"))
        self.assertIn("Disallow: /private", result["text"])

    def test_http_error_statuses_are_returned_without_crashing(self):
        for status in (403, 404, 429, 500):
            with self.subTest(status=status):
                result = asyncio.run(
                    scrape_url(
                        f"{self.base}/{status}",
                        allow_private=True,
                        dynamic_fallback=False,
                    )
                )
                self.assertEqual(result["httpStatus"], status)

    def test_timeout_isolated_to_request(self):
        with self.assertRaises(Exception):
            asyncio.run(
                scrape_url(
                    f"{self.base}/slow",
                    allow_private=True,
                    dynamic_fallback=False,
                    timeout_ms=500,
                )
            )

    def test_dynamic_fallback_executes_controlled_javascript(self):
        result = asyncio.run(
            scrape_url(
                f"{self.base}/dynamic",
                allow_private=True,
                dynamic_fallback=True,
                timeout_ms=20_000,
            )
        )
        self.assertEqual(result["fetchMode"], "Dynamic")
        self.assertEqual(result["discordLinks"], ["https://discord.gg/dynamic"])

    def test_dynamic_icon_button_window_open_is_captured_without_popup_navigation(self):
        result = asyncio.run(
            scrape_url(
                f"{self.base}/dynamic-popup",
                allow_private=True,
                dynamic_fallback=True,
                timeout_ms=20_000,
            )
        )
        self.assertEqual(result["fetchMode"], "Dynamic")
        self.assertEqual(result["discordLinks"], ["https://discord.gg/popup-code"])

    def test_dynamic_social_control_mounted_after_scroll_is_clicked(self):
        result = asyncio.run(
            scrape_url(
                f"{self.base}/dynamic-scroll-popup",
                allow_private=True,
                dynamic_fallback=True,
                timeout_ms=20_000,
            )
        )
        self.assertEqual(result["fetchMode"], "Dynamic")
        self.assertEqual(result["discordLinks"], ["https://discord.gg/late-code"])

    def test_dynamic_rust_nfa_variant_loaded_after_scroll_is_extracted(self):
        result = asyncio.run(
            scrape_url(
                f"{self.base}/dynamic-nfa",
                allow_private=True,
                force_dynamic=True,
                discovery_mode="rust-price",
                timeout_ms=20_000,
            )
        )
        self.assertTrue(
            any(
                listing["name"] == "Premium, Inactive 15 Days"
                and listing["priceText"] == "$4.10"
                for listing in result["rustPriceListings"]
            )
        )


if __name__ == "__main__":
    unittest.main()
