from __future__ import annotations

import asyncio
import base64
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from apps.scraper.src.service import extract_page, normalize_discord, scrape_url, validate_public_url
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


if __name__ == "__main__":
    unittest.main()
