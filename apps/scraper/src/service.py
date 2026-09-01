from __future__ import annotations

import asyncio
import base64
import binascii
import ipaddress
import json
import os
import re
import socket
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote, urljoin, urlparse, urlunparse

from curl_cffi.const import CurlOpt
from curl_cffi.requests import AsyncSession as CurlAsyncSession
from curl_cffi.requests.exceptions import (
    ConnectionError as CurlConnectionError,
    DNSError as CurlDNSError,
    SSLError as CurlSSLError,
    Timeout as CurlTimeout,
)
from scrapling.engines.toolbelt.convertor import ResponseFactory

SERVICE_VERSION = "1.0.0"
USER_AGENT = "FGPLeadResearch/1.0 (+local, respectful scanner)"
MAX_BODY_BYTES = max(1_000_000, int(os.environ.get("SCRAPER_MAX_BODY_BYTES", "10000000")))
MAX_REQUEST_BYTES = 65_536
MAX_SCROLL_STEPS = max(0, min(20, int(os.environ.get("SCRAPER_MAX_SCROLL_STEPS", "6"))))
SCROLL_WAIT_MS = max(25, min(500, int(os.environ.get("SCRAPER_SCROLL_WAIT_MS", "125"))))
DYNAMIC_SETTLE_MS = max(250, min(5_000, int(os.environ.get("SCRAPER_DYNAMIC_SETTLE_MS", "1250"))))
DISCORD_RE = re.compile(
    r"(?:(?:https?:)?//)?(?:www\.)?(?:discord\.gg/[A-Za-z0-9_-]+|discord(?:app)?\.com/(?:invite/[A-Za-z0-9_-]+|channels/\d+(?:/\d+)?|servers/[A-Za-z0-9_-]+|widget/?\?[^\s\"'<>]*\bid=\d+)|(?:e\.)?widgetbot\.io/channels/\d+(?:/\d+)?)[^\s\"'<>]*",
    re.IGNORECASE,
)
TELEGRAM_RE = re.compile(
    r"(?:(?:https?:)?//)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|(?:web\.)?telegram\.org)/[^\s\"'<>]+",
    re.IGNORECASE,
)
EMAIL_RE = re.compile(r"(?<![\w.+-])([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63})(?![\w.-])", re.IGNORECASE)
CONTACT_PATH_RE = re.compile(
    r"(?:^|[-_/])(contacts?(?:-us)?|about(?:-us)?|community|discord|dsc|dc|invite|join|socials?|support|help|links?|team|faq|forums?|chat|reviews?|testimonials?)(?:[-_/.]|$)",
    re.IGNORECASE,
)
LOW_VALUE_CONTENT_PATH_RE = re.compile(
    r"(?:^|/)(?:blogs?|articles?|news|products?|product-category|categories|store|shop|forums?/topic)(?:/|$)",
    re.IGNORECASE,
)
SOCIAL_HOSTS = {
    "t.me": "telegram",
    "telegram.me": "telegram",
    "telegram.dog": "telegram",
    "telegram.org": "telegram",
    "twitter.com": "twitter",
    "x.com": "twitter",
    "youtube.com": "youtube",
    "youtu.be": "youtube",
    "instagram.com": "instagram",
    "facebook.com": "facebook",
    "fb.com": "facebook",
    "vk.com": "vk",
    "linkedin.com": "linkedin",
    "github.com": "github",
    "linktr.ee": "linktree",
    "beacons.ai": "beacons",
    "carrd.co": "carrd",
    "solo.to": "link-aggregator",
    "allmylinks.com": "link-aggregator",
    "bio.link": "link-aggregator",
    "taplink.cc": "link-aggregator",
    "guns.lol": "link-aggregator",
    "dsc.gg": "discord-landing",
    "discord.io": "discord-landing",
    "discord.me": "discord-landing",
    "discord.link": "discord-landing",
    "invite.gg": "discord-landing",
}
SOFT_404_RE = re.compile(
    r"(?:^|\b)(?:404|page\s+(?:was\s+)?not\s+found|page\s+does(?:n['’]t|\s+not)\s+exist|content\s+not\s+found)(?:\b|$)",
    re.IGNORECASE,
)
PRICE_TEXT_RE = re.compile(
    r"(?<![\w])(?:([$€£¥])\s*([0-9]{1,7}(?:[.,][0-9]{1,2})?)|([0-9]{1,7}(?:[.,][0-9]{1,2})?)\s*(USD|EUR|GBP|CAD|AUD|RUB|UAH|PLN|SEK|NOK|DKK|JPY|CNY|USDT|₽|₴|zł|kr))(?![\w])",
    re.IGNORECASE,
)
RUST_NFA_RE = re.compile(
    r"(?:\brust\b.{0,100}\b(?:nfa|non[-\s]?full\s+access|no\s+full\s+access)\b|\b(?:nfa|non[-\s]?full\s+access|no\s+full\s+access)\b.{0,100}\brust\b)",
    re.IGNORECASE | re.DOTALL,
)
NFA_VARIANT_RE = re.compile(
    r"(?:\b(?:premium|basic|aged|random)\b|\binactive\s+\d+\s+days?\b|\b\d+(?:\s*[-\u2013\u2014]\s*\d+|\s*(?:k)?\+)\s*(?:hours?|hrs?)\b|[$€£₽]\s*\d+\+?\s*inventory\b)",
    re.IGNORECASE,
)
PRICE_CLASS_RE = re.compile(
    r"(?:^|[-_\s])(?:price|amount|cost|product-price|sale-price)(?:$|[-_\s])",
    re.IGNORECASE,
)
OUT_OF_STOCK_RE = re.compile(r"\b(?:out\s+of\s+stock|sold\s+out|unavailable)\b", re.IGNORECASE)
IN_STOCK_RE = re.compile(r"\b(?:in\s+stock|available|buy\s+now|add\s+to\s+cart)\b", re.IGNORECASE)
CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₽": "RUB", "₴": "UAH", "zł": "PLN", "kr": "SEK"}
NFA_INTERFACE_RE = re.compile(
    r"\b(?:out\s+of\s+stock|sold\s+out|unavailable|add\s+to\s+cart|buy\s+now|select(?:\s+option)?|quantity)\b",
    re.IGNORECASE,
)
GLOBAL_SLOTS = threading.BoundedSemaphore(max(1, int(os.environ.get("SCRAPER_GLOBAL_CONCURRENCY", "32"))))
DYNAMIC_SLOTS = threading.BoundedSemaphore(
    max(1, min(4, int(os.environ.get("SCRAPER_DYNAMIC_CONCURRENCY", "3"))))
)
HOST_LOCKS: dict[str, threading.Lock] = {}
HOST_LOCKS_GUARD = threading.Lock()
DNS_CACHE: dict[tuple[str, int], tuple[float, list[str]]] = {}
DNS_CACHE_GUARD = threading.Lock()
DNS_CACHE_TTL_SECONDS = max(
    5,
    min(300, int(os.environ.get("SCRAPER_DNS_CACHE_TTL_SECONDS", "60"))),
)
DEVELOPMENT_SCRAPER_TOKEN = "aether-dev-local-worker"


class ScraperError(RuntimeError):
    pass


def configured_scraper_token() -> str:
    token = os.environ.get("SCRAPER_TOKEN", "").strip()
    if os.environ.get("NODE_ENV") == "production" and (
        len(token) < 24
        or token == DEVELOPMENT_SCRAPER_TOKEN
        or "REPLACE_WITH" in token
    ):
        raise ScraperError(
            "SCRAPER_TOKEN must be a unique secret of at least 24 characters in production"
        )
    return token or DEVELOPMENT_SCRAPER_TOKEN


def _is_private_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return True
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def resolve_public_target(value: str, *, allow_private: bool = False) -> tuple[str, list[str]]:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ScraperError("Only public HTTP(S) URLs are allowed")
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname in {"localhost", "metadata.google.internal"} or hostname.endswith((".localhost", ".local")):
        if not allow_private:
            raise ScraperError("Internal host blocked")
    if allow_private:
        return value, []
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    cache_key = (hostname, port)
    with DNS_CACHE_GUARD:
        cached = DNS_CACHE.get(cache_key)
        if cached and cached[0] > time.monotonic():
            return value, list(cached[1])
    try:
        records = socket.getaddrinfo(hostname, port)
    except OSError as error:
        raise ScraperError(f"DNS lookup failed: {error}") from error
    addresses = {record[4][0] for record in records}
    if not addresses or any(_is_private_ip(address) for address in addresses):
        raise ScraperError("Private or internal address blocked")
    approved_addresses = sorted(addresses)
    with DNS_CACHE_GUARD:
        if len(DNS_CACHE) >= 2_048:
            now = time.monotonic()
            for key, entry in list(DNS_CACHE.items()):
                if entry[0] <= now:
                    DNS_CACHE.pop(key, None)
            if len(DNS_CACHE) >= 2_048:
                DNS_CACHE.pop(next(iter(DNS_CACHE)))
        DNS_CACHE[cache_key] = (
            time.monotonic() + DNS_CACHE_TTL_SECONDS,
            approved_addresses,
        )
    return value, approved_addresses


def validate_public_url(value: str, *, allow_private: bool = False) -> str:
    return resolve_public_target(value, allow_private=allow_private)[0]


def _curl_resolve_entry(value: str, addresses: list[str]) -> str:
    parsed = urlparse(value)
    hostname = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    encoded = [f"[{address}]" if ":" in address else address for address in addresses]
    return f"{hostname}:{port}:{','.join(encoded)}"


def normalize_discord(value: str, *, allow_root_destination: bool = False) -> str | None:
    decoded = unquote(unescape(value))
    decoded = re.sub(
        r"\\u([0-9a-fA-F]{4})",
        lambda match: chr(int(match.group(1), 16)),
        decoded,
    )
    decoded = re.sub(r"\\u002[fF]|\\x2[fF]", "/", decoded)
    decoded = decoded.replace(r"\/", "/")
    if allow_root_destination:
        try:
            direct = urlparse(decoded if re.match(r"https?://", decoded, re.I) else f"https://{decoded}")
            direct_host = (direct.hostname or "").lower().removeprefix("www.")
            if direct_host == "discord.gg" and direct.path.rstrip("/") == "":
                return "https://discord.gg/"
        except ValueError:
            pass
    match = DISCORD_RE.search(decoded)
    if not match:
        return None
    candidate = match.group(0)
    if candidate.startswith("//"):
        candidate = f"https:{candidate}"
    elif not re.match(r"https?://", candidate, re.I):
        candidate = f"https://{candidate}"
    parsed = urlparse(candidate)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    path = parsed.path.rstrip("/")
    if host == "discord.gg":
        code = path.strip("/").split("/", 1)[0]
        if code:
            return f"https://discord.gg/{code}"
        return "https://discord.gg/" if allow_root_destination else None
    invite = re.match(r"^/invite/([A-Za-z0-9_-]+)", path, re.I)
    if invite:
        return f"https://discord.gg/{invite.group(1)}"
    channel = re.match(r"^/channels/(\d+)(?:/(\d+))?", path, re.I)
    if channel:
        suffix = f"/{channel.group(2)}" if channel.group(2) else ""
        return f"https://discord.com/channels/{channel.group(1)}{suffix}"
    server = re.match(r"^/servers/([A-Za-z0-9_-]+)", path, re.I)
    if server:
        return f"https://discord.com/servers/{server.group(1)}"
    if host in {"discord.com", "discordapp.com"} and path.rstrip("/") == "/widget":
        widget = re.search(r"(?:^|&)id=(\d+)(?:&|$)", parsed.query)
        if widget:
            return f"https://discord.com/channels/{widget.group(1)}"
    if host in {"widgetbot.io", "e.widgetbot.io"}:
        widgetbot = re.match(r"^/channels/(\d+)(?:/(\d+))?", path, re.I)
        if widgetbot:
            suffix = f"/{widgetbot.group(2)}" if widgetbot.group(2) else ""
            return f"https://discord.com/channels/{widgetbot.group(1)}{suffix}"
    return None


def normalize_telegram(value: str) -> str | None:
    decoded = _decode_embedded_text(value).strip().rstrip("),.;]}")
    match = TELEGRAM_RE.search(decoded)
    if not match:
        return None
    candidate = match.group(0)
    if candidate.startswith("//"):
        candidate = f"https:{candidate}"
    elif not re.match(r"https?://", candidate, re.I):
        candidate = f"https://{candidate}"
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower().removeprefix("www.")
    path = re.sub(r"/{2,}", "/", parsed.path or "/").rstrip("/")
    if host in {"t.me", "telegram.me", "telegram.dog"}:
        if not path:
            return None
        return urlunparse(("https", "t.me", path, "", parsed.query, parsed.fragment))
    if host in {"telegram.org", "web.telegram.org"}:
        if not path and not parsed.fragment:
            return None
        return urlunparse(("https", host, path or "/", "", parsed.query, parsed.fragment))
    return None


def normalize_link(value: str, page_url: str) -> str | None:
    try:
        parsed = urlparse(urljoin(page_url, unescape(value.strip())))
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or "/", "", parsed.query, ""))


def _first(page: Any, selector: str) -> str:
    value = page.css(selector).get()
    return unescape(value).strip() if value else ""


def _text_content(page: Any) -> str:
    values = page.xpath(
        "//body//text()[not(ancestor::script) and not(ancestor::style) and not(ancestor::noscript)]"
    ).getall()
    return " ".join(value.strip() for value in values if value and value.strip())


def _decode_embedded_text(value: str) -> str:
    decoded = unquote(unescape(value))
    decoded = re.sub(
        r"\\u([0-9a-fA-F]{4})",
        lambda match: chr(int(match.group(1), 16)),
        decoded,
    )
    decoded = re.sub(
        r"\\x([0-9a-fA-F]{2})",
        lambda match: chr(int(match.group(1), 16)),
        decoded,
    )
    return decoded.replace(r"\/", "/")


def _price_parts(value: str, currency_hint: str = "") -> tuple[int, str, str] | None:
    match = PRICE_TEXT_RE.search(unescape(value).replace("\u00a0", " "))
    if not match:
        plain = re.fullmatch(r"\s*([0-9]{1,7}(?:[.,][0-9]{1,2})?)\s*", value)
        if not plain or not currency_hint:
            return None
        amount_text = plain.group(1)
        currency_token = currency_hint
        display = f"{amount_text} {currency_hint}"
    else:
        amount_text = match.group(2) or match.group(3)
        currency_token = match.group(1) or match.group(4) or currency_hint
        display = match.group(0).strip()
    normalized_number = amount_text.replace(",", ".")
    try:
        amount_minor = round(float(normalized_number) * 100)
    except ValueError:
        return None
    if amount_minor <= 0:
        return None
    token = currency_token.strip()
    currency = CURRENCY_SYMBOLS.get(token, token.upper())
    if currency not in {"USD", "EUR", "GBP", "CAD", "AUD", "RUB", "UAH", "PLN", "SEK", "NOK", "DKK", "JPY", "CNY", "USDT"}:
        return None
    return amount_minor, currency, display


def _actual_price_parts(value: str, currency_hint: str = "") -> tuple[int, str, str] | None:
    """Select the advertised price, not an inventory value such as '$100+'."""
    decoded = unescape(value).replace("\u00a0", " ")
    candidates = []
    for match in PRICE_TEXT_RE.finditer(decoded):
        if re.match(r"\s*\+\s*inventory\b", decoded[match.end() : match.end() + 24], re.IGNORECASE):
            continue
        candidates.append(match.group(0))
    return _price_parts(candidates[-1], currency_hint) if candidates else _price_parts(decoded, currency_hint)


def _listing_title(value: str, price_text: str, fallback: str, *, require_nfa: bool = True) -> str:
    compact = re.sub(r"\s+", " ", unescape(value)).strip()
    compact = NFA_INTERFACE_RE.sub(" ", compact)
    if price_text:
        compact = re.sub(re.escape(price_text), " ", compact, count=1, flags=re.IGNORECASE)
    compact = re.sub(r"\s*[|•]\s*|\s+[-–—]\s*$", " ", compact)
    compact = re.sub(r"\s+", " ", compact).strip(" ,-|•")
    if require_nfa and not (NFA_VARIANT_RE.search(compact) or RUST_NFA_RE.search(compact)):
        compact = fallback
    if not compact:
        compact = fallback
    return compact[:300]


def _product_keywords(product_name: str) -> list[str]:
    ignored = {
        "account", "accounts", "item", "items", "game", "games", "price", "prices",
        "sale", "selling", "buy", "shop", "store", "market", "for", "the", "and",
        "nfa", "full", "access",
    }
    return [
        token.lower()
        for token in re.findall(r"[A-Za-z0-9]{3,}", product_name)
        if token.lower() not in ignored
    ][:12]


def extract_rust_price_listings(
    page: Any,
    page_url: str,
    title: str,
    *,
    product_name: str = "Rust NFA accounts",
    product_type: str = "RUST_NFA",
) -> list[dict[str, Any]]:
    listings: dict[str, dict[str, Any]] = {}
    page_text = _text_content(page)
    headings = " ".join(page.css("h1::text, h2::text").getall()[:20])
    rust_mode = product_type.upper() == "RUST_NFA"
    product_keywords = _product_keywords(product_name)
    relevance_text = f"{title} {headings} {page_text[:6000]}".lower()
    page_is_nfa = bool(RUST_NFA_RE.search(relevance_text))
    page_is_product = page_is_nfa if rust_mode else bool(
        product_keywords and any(keyword in relevance_text for keyword in product_keywords)
    )
    inferred_currency = _first(page, 'meta[property="product:price:currency"]::attr(content)') or ("USD" if "$" in page_text else "")

    def add_listing(
        *,
        context: str,
        price_value: str,
        listing_url: str = "",
        method: str,
        currency_hint: str = "",
        name: str = "",
    ) -> None:
        combined = re.sub(r"\s+", " ", f"{name} {context}").strip()
        if rust_mode:
            if not (RUST_NFA_RE.search(combined) or (page_is_nfa and NFA_VARIANT_RE.search(combined))):
                return
        elif (
            not page_is_product
            or (
                method != "VARIANT_CONTROL"
                and product_keywords
                and not any(keyword in combined.lower() for keyword in product_keywords)
            )
        ):
            return
        parsed_price = _actual_price_parts(price_value, currency_hint or inferred_currency)
        if not parsed_price:
            return
        price_minor, currency, price_text = parsed_price
        normalized_url = normalize_link(listing_url, page_url) if listing_url else page_url
        if not normalized_url:
            normalized_url = page_url
        listing_title = _listing_title(
            name or context,
            price_text,
            title or product_name,
            require_nfa=rust_mode,
        )
        key = f"{normalized_url.lower().rstrip('/')}|{listing_title.lower()}"
        listings[key] = {
                "name": listing_title,
                "priceMinor": price_minor,
                "currency": currency,
                "priceText": price_text,
                "link": normalized_url,
                "method": method,
            }

    # Product and Offer JSON-LD is the strongest structured price signal.
    for raw_json in page.css('script[type="application/ld+json"]::text').getall()[:100]:
        try:
            payload = json.loads(raw_json)
        except (json.JSONDecodeError, TypeError):
            continue

        def walk(node: Any, product_name: str = "", product_url: str = "") -> None:
            if isinstance(node, list):
                for child in node[:500]:
                    walk(child, product_name, product_url)
                return
            if not isinstance(node, dict):
                return
            kind = str(node.get("@type", ""))
            local_name = str(node.get("name") or product_name)
            local_url = str(node.get("url") or product_url)
            if kind.lower() in {"product", "individualproduct", "productgroup"}:
                product_name, product_url = local_name, local_url
            if kind.lower() in {"offer", "aggregateoffer"} or "price" in node:
                price = node.get("price") or node.get("lowPrice")
                if price is not None:
                    add_listing(
                        context=f"{product_name} {node.get('description', '')}",
                        name=product_name,
                        price_value=str(price),
                        currency_hint=str(node.get("priceCurrency", "")),
                        listing_url=str(node.get("url") or product_url),
                        method="JSON_LD",
                    )
            for child in node.values():
                if isinstance(child, (dict, list)):
                    walk(child, product_name, product_url)

        walk(payload)

    # Select options, buttons, radio labels, and table rows can each be a variant.
    for control in page.xpath(
        "//option | //button | //label | //tr | //*[@role='option' or @role='radio']"
    )[:1000]:
        text = " ".join(control.xpath(".//text()[not(ancestor::script) and not(ancestor::style)]").getall())
        data_price = control.attrib.get("data-price") or control.attrib.get("data-product-price") or control.attrib.get("data-cost") or ""
        if not data_price and not PRICE_TEXT_RE.search(text):
            continue
        add_listing(
            context=text,
            name=text,
            price_value=data_price or text,
            currency_hint=control.attrib.get("data-currency") or inferred_currency,
            listing_url=control.css("a::attr(href)").get() or control.attrib.get("href") or "",
            method="VARIANT_CONTROL",
        )

    # Common product-card and microdata price nodes preserve the surrounding
    # title/link rather than collapsing all prices into the page title.
    for node in page.xpath(
        "//*[@itemprop='price' or @data-price or @data-product-price"
        " or contains(translate(@class, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'price')"
        " or contains(translate(@id, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'price')]"
    )[:1000]:
        if node.xpath("self::button | self::option | self::label"):
            continue
        classes = f"{node.attrib.get('class', '')} {node.attrib.get('id', '')}"
        if not (node.attrib.get("itemprop") == "price" or node.attrib.get("data-price") or node.attrib.get("data-product-price") or PRICE_CLASS_RE.search(classes)):
            continue
        container = node.xpath("ancestor::*[self::tr or self::label or self::article or self::li or self::div or self::section][1]")
        card = container[0] if container else node.parent
        context = " ".join(card.xpath(".//text()[not(ancestor::script) and not(ancestor::style)]").getall())
        price_value = node.attrib.get("content") or node.attrib.get("data-price") or node.attrib.get("data-product-price") or node.text or " ".join(node.xpath(".//text()").getall())
        name = card.css('[itemprop="name"]::text').get() or card.css("h1::text").get() or card.css("h2::text").get() or card.css("h3::text").get() or card.css("a::attr(title)").get() or context
        listing_url = card.css('a[itemprop="url"]::attr(href)').get() or card.css("a::attr(href)").get() or ""
        currency_hint = node.attrib.get("data-currency") or node.attrib.get("currency") or _first(page, 'meta[property="product:price:currency"]::attr(content)')
        add_listing(
            context=context,
            name=name,
            price_value=price_value,
            currency_hint=currency_hint,
            listing_url=listing_url,
            method="PRODUCT_CARD",
        )

    # Page-level product metadata and bounded visible-text fallback cover
    # simple single-listing pages that do not use product markup.
    meta_amount = _first(page, 'meta[property="product:price:amount"]::attr(content)')
    meta_currency = _first(page, 'meta[property="product:price:currency"]::attr(content)')
    if meta_amount:
        add_listing(
            context=f"{title} {page_text[:1200]}",
            name=title,
            price_value=meta_amount,
            currency_hint=meta_currency,
            listing_url=page_url,
            method="PRODUCT_META",
        )
    if page_is_product:
        for block in page.xpath("//tr | //li | //article | //label | //option | //p")[:1500]:
            text = " ".join(block.xpath(".//text()[not(ancestor::script) and not(ancestor::style)]").getall())
            relevant_variant = (
                bool(NFA_VARIANT_RE.search(text))
                if rust_mode
                else bool(
                    PRICE_TEXT_RE.search(text)
                    and (
                        any(keyword in text.lower() for keyword in product_keywords)
                        or block.xpath("ancestor::*[@itemtype or @data-product-id][1]")
                    )
                )
            )
            if relevant_variant and PRICE_TEXT_RE.search(text):
                add_listing(context=text, name=text, price_value=text, listing_url=block.css("a::attr(href)").get() or "", method="VISIBLE_TEXT")
    return list(listings.values())[:500]


def _internal_priority(path: str, *, discord_label: bool = False, priority_label: bool = False) -> int:
    lowered = path.lower()
    if discord_label or re.search(r"(?:^|[-_/])(?:discord|dsc|dc)(?:[-_/.]|$)", lowered):
        return -40
    if re.search(r"(?:^|[-_/])(?:invite|join)(?:[-_/.]|$)", lowered):
        return -30
    if re.search(r"(?:^|[-_/])(?:community|socials?|chat)(?:[-_/]|$)", lowered):
        return -20
    if priority_label:
        return -10
    if CONTACT_PATH_RE.search(path):
        return 5 if LOW_VALUE_CONTENT_PATH_RE.search(path) else -10
    return 10


def extract_page(
    page: Any,
    requested_url: str,
    *,
    fetch_mode: str,
    duration_ms: int,
    product_name: str = "Rust NFA accounts",
    product_type: str = "RUST_NFA",
) -> dict[str, Any]:
    raw = page.body
    if len(raw.encode("utf-8") if isinstance(raw, str) else raw) > MAX_BODY_BYTES:
        raise ScraperError("Response exceeds size limit")
    html = raw if isinstance(raw, str) else raw.decode(getattr(page, "encoding", "utf-8") or "utf-8", errors="replace")
    page_url = str(page.url or requested_url)
    headers = {
        str(key).lower(): str(value)
        for key, value in dict(getattr(page, "headers", {}) or {}).items()
    }
    redirect = headers.get("location", "")
    if redirect:
        redirect = urljoin(page_url, redirect)
    hrefs = page.css("a::attr(href)").getall()
    script_links = []
    for source in page.css("script::attr(src)").getall():
        normalized_source = normalize_link(source, page_url)
        if not normalized_source:
            continue
        source_host = (urlparse(normalized_source).hostname or "").lower().removeprefix("www.")
        page_host_for_scripts = (urlparse(page_url).hostname or "").lower().removeprefix("www.")
        if source_host == page_host_for_scripts and normalized_source not in script_links:
            script_links.append(normalized_source)
    icon_hrefs = set(
        page.xpath(
            "//a[.//*[local-name()='svg'] or .//img or @aria-label or @title"
            " or contains(translate(@class, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'discord')"
            " or .//*[@data-icon or contains(translate(@class, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'discord')]]/@href"
        ).getall()
    )
    header_hrefs = set(page.xpath("//header//a/@href").getall())
    footer_hrefs = set(page.xpath("//footer//a/@href").getall())
    navigation_hrefs = set(page.xpath("//nav//a/@href").getall())
    faq_hrefs = set(
        page.xpath(
            "//*[contains(translate(@id, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'faq')"
            " or contains(translate(@class, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'faq')]//a/@href"
        ).getall()
    )
    priority_hrefs: set[str] = set()
    discord_landing_hrefs: set[str] = set()
    upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    lower = "abcdefghijklmnopqrstuvwxyz"
    for keyword in (
        "discord",
        "community",
        "social",
        "contact",
        "support",
        "help",
        "links",
        "about",
        "faq",
        "forum",
        "chat",
        "review",
        "testimonial",
    ):
        priority_hrefs.update(
            page.xpath(
                f"//a[contains(translate(normalize-space(string(.)), '{upper}', '{lower}'), '{keyword}')"
                f" or contains(translate(@aria-label, '{upper}', '{lower}'), '{keyword}')"
                f" or contains(translate(@title, '{upper}', '{lower}'), '{keyword}')"
                f" or contains(translate(@class, '{upper}', '{lower}'), '{keyword}')"
                f" or .//*[contains(translate(@alt, '{upper}', '{lower}'), '{keyword}')"
                f" or contains(translate(@class, '{upper}', '{lower}'), '{keyword}')]]/@href"
            ).getall()
        )
    discord_landing_hrefs.update(
        page.xpath(
            f"//a[contains(translate(@href, '{upper}', '{lower}'), 'discord')"
            f" or contains(translate(normalize-space(string(.)), '{upper}', '{lower}'), 'discord')"
            f" or contains(translate(@aria-label, '{upper}', '{lower}'), 'discord')"
            f" or contains(translate(@title, '{upper}', '{lower}'), 'discord')"
            f" or contains(translate(@class, '{upper}', '{lower}'), 'discord')"
            f" or .//*[contains(translate(@alt, '{upper}', '{lower}'), 'discord')"
            f" or contains(translate(@src, '{upper}', '{lower}'), 'discord')"
            f" or contains(translate(@class, '{upper}', '{lower}'), 'discord')"
            f" or contains(translate(@data-icon, '{upper}', '{lower}'), 'discord')]]/@href"
        ).getall()
    )
    text = _text_content(page)
    discord: dict[str, dict[str, str]] = {}
    emails: set[str] = {match.group(1).lower() for match in EMAIL_RE.finditer(unescape(html))}
    socials: dict[str, dict[str, str]] = {}
    internal: dict[str, int] = {}
    page_host = (urlparse(page_url).hostname or "").lower().removeprefix("www.")
    content_type = headers.get("content-type", "")
    is_xml_document = "xml" in content_type.lower() or page_url.lower().split("?", 1)[0].endswith(".xml")

    def add_discord(
        value: str,
        method: str,
        section: str = "UNKNOWN",
        interaction: str = "NONE",
    ) -> None:
        normalized = normalize_discord(
            value,
            allow_root_destination=method in {"anchor", "icon-anchor", "redirect-location"},
        )
        if normalized and normalized not in discord:
            hit = {
                "method": "rendered-dom" if fetch_mode == "Dynamic" else method,
                "section": section,
                "interaction": "SCROLL" if fetch_mode == "Dynamic" and MAX_SCROLL_STEPS else interaction,
            }
            discord[normalized] = hit

    def add_telegram(value: str) -> None:
        normalized = normalize_telegram(value)
        if normalized:
            socials[normalized] = {
                "type": "telegram",
                "url": normalized,
                "sourcePage": page_url,
            }

    if redirect:
        add_discord(redirect, "redirect-location")

    for raw_href in hrefs:
        if not raw_href:
            continue
        if raw_href.lower().startswith("mailto:"):
            email = raw_href[7:].split("?", 1)[0].strip().lower()
            if EMAIL_RE.fullmatch(email):
                emails.add(email)
        section = (
            "HEADER"
            if raw_href in header_hrefs
            else "FOOTER"
            if raw_href in footer_hrefs
            else "NAVIGATION"
            if raw_href in navigation_hrefs
            else "FAQ"
            if raw_href in faq_hrefs
            else "MAIN"
        )
        add_discord(
            raw_href,
            "icon-anchor" if raw_href in icon_hrefs else "anchor",
            section,
        )
        normalized = normalize_link(raw_href, page_url)
        if not normalized:
            continue
        parsed = urlparse(normalized)
        host = (parsed.hostname or "").lower().removeprefix("www.")
        for social_host, kind in SOCIAL_HOSTS.items():
            if host == social_host or host.endswith(f".{social_host}"):
                if kind == "telegram":
                    add_telegram(raw_href)
                else:
                    socials[normalized] = {"type": kind, "url": normalized, "sourcePage": page_url}
                break
        if (
            host != page_host
            and raw_href in discord_landing_hrefs
            and not normalize_discord(raw_href, allow_root_destination=True)
        ):
            # Some sites label a branded cross-domain route as Discord and let
            # that public landing page perform the final redirect. Record it as
            # a single controlled social hop; the Node crawler still validates
            # the destination and never recursively follows external sites.
            socials[normalized] = {
                "type": "discord-landing",
                "url": normalized,
                "sourcePage": page_url,
            }
        if host == page_host:
            score = _internal_priority(
                parsed.path,
                discord_label=raw_href in discord_landing_hrefs,
                priority_label=raw_href in priority_hrefs,
            )
            if parsed.path in {"", "/"}:
                score += 20
            if not re.search(r"\.(?:jpg|jpeg|png|gif|svg|webp|pdf|zip|css|js|xml|json|rss)$", parsed.path, re.I):
                internal[normalized] = min(score, internal.get(normalized, score))

    if is_xml_document:
        # Public sitemaps declare candidate pages. They are still subject to
        # robots, redirect, DNS/IP and page-budget checks before being fetched.
        sitemap_values = page.xpath("//*[local-name()='loc']/text()").getall()
        if not sitemap_values:
            sitemap_values = re.findall(r"<loc[^>]*>\s*([^<]+?)\s*</loc>", html, re.I)
        for sitemap_value in sitemap_values[:5000]:
            normalized_sitemap = normalize_link(sitemap_value, page_url)
            if not normalized_sitemap:
                continue
            parsed_sitemap = urlparse(normalized_sitemap)
            sitemap_host = (parsed_sitemap.hostname or "").lower().removeprefix("www.")
            if sitemap_host != page_host:
                continue
            score = _internal_priority(parsed_sitemap.path)
            internal[normalized_sitemap] = min(score, internal.get(normalized_sitemap, score))

    destination_attributes: list[tuple[str, str]] = [
        ('//*[@data-href]/@data-href', "data-attribute"),
        ('//*[@data-url]/@data-url', "data-attribute"),
        ('//*[@data-link]/@data-link', "data-attribute"),
        ('//*[@data-target]/@data-target', "data-attribute"),
        ('//*[@formaction]/@formaction', "data-attribute"),
        ('//*[@onclick]/@onclick', "onclick-attribute"),
    ]
    for selector, method in (
        *destination_attributes,
        ('//*[@src]/@src', "source-attribute"),
        ('//*[@aria-label]/@aria-label', "icon-metadata"),
        ('//*[@title]/@title', "icon-metadata"),
        ('//*[@alt]/@alt', "icon-metadata"),
        ('//*[@data-icon]/@data-icon', "icon-metadata"),
        ('//*[@class]/@class', "icon-metadata"),
    ):
        for value in page.xpath(selector).getall():
            add_discord(value, method)
    for value in DISCORD_RE.finditer(text):
        add_discord(value.group(0), "visible-text")
    for value in TELEGRAM_RE.finditer(text):
        add_telegram(value.group(0))
    script_text = " ".join(page.xpath("//script//text()").getall())
    decoded_script = _decode_embedded_text(script_text)
    # Static JavaScript configuration often assembles public destinations from
    # adjacent string literals. Joining only literal-to-literal concatenations
    # exposes the URL without evaluating arbitrary JavaScript.
    decoded_script = re.sub(r"(['\"])\s*\+\s*\1", "", decoded_script)
    for value in DISCORD_RE.finditer(decoded_script):
        add_discord(value.group(0), "embedded-data")
    for value in TELEGRAM_RE.finditer(decoded_script):
        add_telegram(value.group(0))
    decoded_html = _decode_embedded_text(html)
    for value in DISCORD_RE.finditer(decoded_html):
        add_discord(value.group(0), "html-source")
    for value in TELEGRAM_RE.finditer(decoded_html):
        add_telegram(value.group(0))

    # Decode a bounded number of inert Base64 strings commonly used in public
    # hydration/configuration payloads. This is string inspection only; no code
    # is executed and invalid or binary payloads are ignored.
    encoded_tokens = re.findall(r"(?<![A-Za-z0-9_+/-])([A-Za-z0-9_+/-]{16,1024}={0,2})(?![A-Za-z0-9_+/-])", html)
    for token in encoded_tokens[:200]:
        try:
            padded = token + "=" * (-len(token) % 4)
            raw_token = base64.b64decode(padded.replace("-", "+").replace("_", "/"), validate=True)
            decoded_token = raw_token.decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            continue
        if len(decoded_token) > 4096:
            continue
        for value in DISCORD_RE.finditer(_decode_embedded_text(decoded_token)):
            add_discord(value.group(0), "embedded-data")
        for value in TELEGRAM_RE.finditer(_decode_embedded_text(decoded_token)):
            add_telegram(value.group(0))

    # Recover statically-declared navigation targets such as meta refresh,
    # location.href, location.assign/replace, data-url and onclick routes. A
    # destination is queued only when it is same-site or an approved social
    # hop; the crawler still performs DNS/IP SSRF validation before fetching.
    navigation_values: list[tuple[str, bool]] = []
    for content in page.xpath(
        "//meta[translate(@http-equiv, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='refresh']/@content"
    ).getall():
        match = re.search(r"(?:^|;)\s*url\s*=\s*['\"]?([^'\";\s]+)", unescape(content), re.I)
        if match:
            navigation_values.append((match.group(1), True))
    for selector, _ in destination_attributes:
        for attribute_value in page.xpath(selector).getall():
            direct = normalize_link(attribute_value, page_url)
            if direct:
                navigation_values.append((attribute_value, "discord" in attribute_value.lower()))
            for match in re.finditer(
                r"(?:(?:window\.)?location(?:\.href)?\s*=|(?:window\.)?location\.(?:assign|replace)\s*\()\s*['\"]([^'\"]+)['\"]",
                _decode_embedded_text(attribute_value),
                re.I,
            ):
                navigation_values.append((match.group(1), True))
    for match in re.finditer(
        r"(?:(?:window\.)?location(?:\.href)?\s*=|(?:window\.)?location\.(?:assign|replace)\s*\()\s*['\"]([^'\"]+)['\"]",
        decoded_script,
        re.I,
    ):
        navigation_values.append((match.group(1), True))
    for destination, priority_signal in navigation_values[:200]:
        add_discord(destination, "onclick-attribute")
        normalized_destination = normalize_link(destination, page_url)
        if not normalized_destination:
            continue
        parsed_destination = urlparse(normalized_destination)
        destination_host = (parsed_destination.hostname or "").lower().removeprefix("www.")
        if destination_host == page_host:
            if not re.search(r"\.(?:jpg|jpeg|png|gif|svg|webp|pdf|zip|css|js|xml|json|rss)$", parsed_destination.path, re.I):
                score = _internal_priority(parsed_destination.path, priority_label=priority_signal)
                internal[normalized_destination] = min(score, internal.get(normalized_destination, score))
            continue
        for social_host, kind in SOCIAL_HOSTS.items():
            if destination_host == social_host or destination_host.endswith(f".{social_host}"):
                if kind == "telegram":
                    add_telegram(destination)
                else:
                    socials[normalized_destination] = {
                        "type": kind,
                        "url": normalized_destination,
                        "sourcePage": page_url,
                    }
                break

    canonical_raw = _first(page, 'link[rel="canonical"]::attr(href)')
    favicon_raw = _first(page, 'link[rel~="icon"]::attr(href)')
    description = _first(page, 'meta[name="description"]::attr(content)')
    if not description:
        description = _first(page, 'meta[property="og:description"]::attr(content)')
    title = _first(page, "title::text") or _first(page, 'meta[property="og:title"]::attr(content)')
    shell = bool(
        200 <= int(getattr(page, "status", 200)) < 300
        and "html" in content_type.lower()
        and len(text) < 80
        and len(page.css("script").getall()) > 0
        and not discord
        and not emails
    )
    framework_page = bool(
        not discord
        and re.search(
            r"(?:__NEXT_DATA__|/_next/static/|__NUXT__|webpack|data-reactroot|id=[\"'](?:root|app)[\"'])",
            html,
            re.IGNORECASE,
        )
    )
    rust_price_listings = extract_rust_price_listings(
        page,
        page_url,
        title,
        product_name=product_name,
        product_type=product_type,
    )
    return {
        "requestedUrl": requested_url,
        "finalUrl": page_url,
        "redirectUrl": redirect or None,
        "httpStatus": int(getattr(page, "status", 200)),
        "title": title[:500],
        "metaDescription": description[:2000],
        "canonicalUrl": normalize_link(canonical_raw, page_url) if canonical_raw else None,
        "faviconUrl": normalize_link(favicon_raw, page_url) if favicon_raw else None,
        "contentType": content_type,
        "fetchMode": fetch_mode,
        "discordLinks": sorted(discord),
        "discordDetections": [
            {
                "url": url,
                "method": discord[url]["method"],
                **(
                    {"section": discord[url]["section"]}
                    if discord[url]["section"] != "UNKNOWN"
                    else {}
                ),
                **(
                    {"interaction": discord[url]["interaction"]}
                    if discord[url]["interaction"] != "NONE"
                    else {}
                ),
            }
            for url in sorted(discord)
        ],
        "emails": sorted(emails)[:100],
        "socialLinks": sorted(socials.values(), key=lambda item: (item["type"], item["url"]))[:200],
        "internalLinks": [url for url, _ in sorted(internal.items(), key=lambda item: (item[1], item[0]))][:500],
        "priorityLinks": [
            url
            for url, score in sorted(internal.items(), key=lambda item: (item[1], item[0]))
            if score <= 0
        ][:100],
        "scriptLinks": script_links[:12],
        "rustPriceListings": rust_price_listings,
        "durationMs": duration_ms,
        "looksDynamic": shell or framework_page,
        "staticFetchResult": "SUCCESS",
        "dynamicFetchResult": "SUCCESS" if fetch_mode == "Dynamic" else "NOT_ATTEMPTED",
        "dynamicError": "",
        "retryAfterSeconds": _retry_after_seconds(headers),
        "isSoft404": bool(
            200 <= int(getattr(page, "status", 200)) < 300
            and (
                SOFT_404_RE.search(title or "")
                or SOFT_404_RE.search(_first(page, "h1::text"))
                or (len(text) < 1200 and SOFT_404_RE.search(text))
            )
        ),
    }


def _load_dynamic_fetcher() -> Any:
    # Scrapling 0.4.11 currently asks BrowserForge for an exact, not-yet-present
    # Chromium profile on some installations. Keep the dependency untouched and
    # fall back to our explicit, ordinary user-agent if that initialization fails.
    import scrapling.engines.toolbelt.fingerprints as fingerprints

    original = fingerprints.generate_headers

    def compatible_headers(browser_mode: bool | str = False) -> dict[str, str]:
        try:
            return original(browser_mode)
        except ValueError:
            return {"User-Agent": USER_AGENT}

    fingerprints.generate_headers = compatible_headers
    try:
        from scrapling.fetchers import DynamicFetcher

        return DynamicFetcher
    finally:
        fingerprints.generate_headers = original


async def _dynamic_page(
    url: str,
    timeout_ms: int,
    *,
    allow_private: bool,
    pinned_addresses: list[str],
    discovery_mode: str = "discord",
) -> Any:
    approved_host = (urlparse(url).hostname or "").lower()
    approved_public_hosts: dict[str, bool] = {approved_host: True}
    captured_main_redirects: list[str] = []

    async def setup(page: Any) -> None:
        await page.add_init_script(
            r"""(() => {
                const captured = [];
                Object.defineProperty(window, '__fgpCapturedSocialDestinations', {
                    value: captured,
                    configurable: false,
                    writable: false
                });
                const originalOpen = window.open;
                window.open = function(url) {
                    try {
                        const value = String(url || '');
                        if (value) captured.push(value);
                    } catch {}
                    return null;
                };
                window.open.toString = () => originalOpen.toString();
            })()"""
        )

        async def guard(route: Any, request: Any) -> None:
            candidate = request.url
            parsed = urlparse(candidate)
            if parsed.scheme not in {"http", "https", "data", "blob"}:
                await route.abort()
                return
            if parsed.scheme in {"data", "blob"}:
                await route.continue_()
                return
            request_host = (parsed.hostname or "").lower()
            # Keep the renderer entirely on the approved, DNS-pinned host.
            # Static extraction still records external social destinations,
            # but the browser never contacts cross-origin scripts, XHR, images,
            # or frames where DNS rebinding could target a private service.
            if request_host != approved_host:
                # A first-party `/discord` route often performs a client-side
                # top-level navigation to the invite. Do not permit the browser
                # to leave the approved site, but preserve a validated public
                # destination as inert extraction evidence.
                if (
                    request.resource_type == "document"
                    and request.frame == page.main_frame
                ):
                    try:
                        await asyncio.to_thread(
                            validate_public_url,
                            candidate,
                            allow_private=allow_private,
                        )
                        if candidate not in captured_main_redirects:
                            captured_main_redirects.append(candidate)
                    except ScraperError:
                        pass
                await route.abort()
                return
            try:
                if request_host not in approved_public_hosts:
                    await asyncio.to_thread(
                        validate_public_url,
                        candidate,
                        allow_private=allow_private,
                    )
                    approved_public_hosts[request_host] = True
            except ScraperError:
                await route.abort()
                return
            await route.continue_()

        await page.route("**/*", guard)

    async def inspect_full_page(page: Any) -> None:
        # A bounded scroll makes below-the-fold and lazy-loaded public social
        # controls part of the rendered DOM snapshot. It never clicks, submits,
        # logs in, or follows an external destination.
        await page.wait_for_timeout(DYNAMIC_SETTLE_MS)
        if captured_main_redirects:
            await page.evaluate(
                """(redirects) => {
                    const box = document.createElement('div');
                    box.id = 'fgp-blocked-main-redirects';
                    box.hidden = true;
                    for (const value of redirects.slice(0, 10)) {
                        const anchor = document.createElement('a');
                        anchor.href = value;
                        anchor.setAttribute('data-fgp-method', 'redirect-location');
                        box.appendChild(anchor);
                    }
                    document.body.appendChild(box);
                }""",
                captured_main_redirects,
            )

        async def has_discord_destination() -> bool:
            try:
                return bool(
                    captured_main_redirects
                    or await page.evaluate(
                        r"""() => {
                            const source = (document.documentElement?.outerHTML || '')
                                .replace(/\\u002f/gi, '/')
                                .replace(/\\\//g, '/');
                            const completeDiscord = /(?:discord\.gg\/[A-Za-z0-9_-]+|discord(?:app)?\.com\/(?:invite\/[A-Za-z0-9_-]+|channels\/\d+(?:\/\d+)?|servers\/[A-Za-z0-9_-]+|widget\/?\?[^\s"'<>]*\bid=\d+)|(?:e\.)?widgetbot\.io\/channels\/\d+(?:\/\d+)?)/i;
                            return completeDiscord.test(source)
                                || (window.__fgpCapturedSocialDestinations || []).some((value) =>
                                    completeDiscord.test(String(value || ''))
                                );
                        }"""
                    )
                )
            except Exception:
                return bool(captured_main_redirects)

        # Most dynamically rendered Discord controls expose their destination
        # as soon as the DOM settles. Skip the click/scroll tiers in that case;
        # extraction still runs against the complete serialized document.
        if discovery_mode != "rust-price" and await has_discord_destination():
            return

        if discovery_mode == "rust-price":
            # Expand only inert public variant controls. Purchase/login actions
            # are explicitly excluded, and navigation remains route-guarded.
            await page.evaluate(
                r"""() => {
                    const useful = /(?:variant|option|more|show|expand|hours?|inactive|premium|inventory|nfa)/i;
                    const dangerous = /(?:buy|purchase|pay|checkout|order|login|sign\s*in|delete|remove|wallet|account|cart)/i;
                    for (const el of [...document.querySelectorAll('button,[role="button"],[aria-expanded="false"]')].slice(0, 200)) {
                        const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.className].filter(Boolean).join(' ');
                        if (useful.test(label) && !dangerous.test(label)) {
                            try { el.click(); } catch {}
                        }
                    }
                }"""
            )
            await page.wait_for_timeout(min(750, DYNAMIC_SETTLE_MS))

        async def click_social_controls() -> None:
            # Expand only public, non-transactional controls whose accessible
            # label describes a social/community surface. Include ordinary
            # anchors because many themes attach a preventDefault/window.open
            # handler to an otherwise innocuous same-site invite route.
            # External top-level navigation remains blocked by the route guard.
            await page.evaluate(
            r"""() => {
                const positive = /(?:discord|community|social|join\s+(?:our\s+)?server)/i;
                const expander = /(?:menu|navigation|socials?|community)/i;
                const dangerous = /(?:buy|purchase|pay|checkout|order|login|sign\s*in|delete|remove|wallet|account)/i;
                const describe = (el) => {
                    const descendants = [...el.querySelectorAll('[aria-label],[title],[alt],[data-icon],[class],[src]')]
                        .slice(0, 20)
                        .flatMap((child) => [
                            child.getAttribute('aria-label'), child.getAttribute('title'),
                            child.getAttribute('alt'), child.getAttribute('data-icon'),
                            child.getAttribute('src'), child.className
                        ]);
                    return [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'),
                        el.getAttribute('src'), el.className, ...descendants]
                        .filter(Boolean).join(' ');
                };
                const controls = [...document.querySelectorAll(
                    'button,input[type="button"],input[type="image"],[role="button"],[onclick],a,' +
                    '[aria-label*="discord" i],[title*="discord" i],[data-icon*="discord" i],[class*="discord" i]'
                )]
                    .filter((el) => {
                        if (el.hasAttribute('data-fgp-clicked')) return false;
                        const label = describe(el);
                        const rect = el.getBoundingClientRect();
                        const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                        const inLowerPage = rect.top + window.scrollY >= pageHeight * 0.6;
                        const imageSocialControl = Boolean(el.querySelector('img')) &&
                            (Boolean(el.closest('footer')) || inLowerPage) && positive.test(label);
                        return (positive.test(label) || expander.test(label) || imageSocialControl) && !dangerous.test(label);
                    }).slice(0, 8);
                for (const control of controls) {
                    try {
                        control.setAttribute('data-fgp-clicked', 'true');
                        control.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                        control.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                        control.click();
                    } catch {}
                }
            }"""
            )

        async def collect_popup_destinations() -> None:
            try:
                popup_destinations = await page.evaluate(
                    "() => [...new Set(window.__fgpCapturedSocialDestinations || [])].slice(0, 20)"
                )
                for destination in popup_destinations or []:
                    try:
                        absolute_destination = urljoin(url, str(destination))
                        await asyncio.to_thread(
                            validate_public_url,
                            absolute_destination,
                            allow_private=allow_private,
                        )
                        if absolute_destination not in captured_main_redirects:
                            captured_main_redirects.append(absolute_destination)
                    except ScraperError:
                        continue
            except Exception:
                pass

        await click_social_controls()
        await page.wait_for_timeout(min(750, DYNAMIC_SETTLE_MS))
        await collect_popup_destinations()
        if await has_discord_destination():
            if captured_main_redirects:
                await page.evaluate(
                    """(redirects) => {
                        let box = document.getElementById('fgp-blocked-main-redirects');
                        if (!box) {
                            box = document.createElement('div');
                            box.id = 'fgp-blocked-main-redirects';
                            box.hidden = true;
                            document.body.appendChild(box);
                        }
                        for (const value of redirects.slice(0, 20)) {
                            const anchor = document.createElement('a');
                            anchor.href = value;
                            anchor.setAttribute('data-fgp-method', 'redirect-location');
                            box.appendChild(anchor);
                        }
                    }""",
                    captured_main_redirects,
                )
            return
        for _ in range(MAX_SCROLL_STEPS):
            state = await page.evaluate(
                """() => ({
                    top: window.scrollY,
                    viewport: window.innerHeight,
                    height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
                })"""
            )
            if state["top"] + state["viewport"] >= state["height"] - 2:
                break
            await page.evaluate("() => window.scrollBy(0, Math.max(window.innerHeight * 0.8, 500))")
            await page.wait_for_timeout(SCROLL_WAIT_MS)

        # Footer and sticky social controls are frequently mounted only after
        # the first scroll. Give that rendered state the same bounded, safe
        # interaction pass and preserve any window.open destination it emits.
        await click_social_controls()
        await page.wait_for_timeout(min(750, DYNAMIC_SETTLE_MS))
        await collect_popup_destinations()

        if captured_main_redirects:
            await page.evaluate(
                """(redirects) => {
                    let box = document.getElementById('fgp-blocked-main-redirects');
                    if (!box) {
                        box = document.createElement('div');
                        box.id = 'fgp-blocked-main-redirects';
                        box.hidden = true;
                        document.body.appendChild(box);
                    }
                    const existing = new Set([...box.querySelectorAll('a[href]')].map((a) => a.href));
                    for (const value of redirects.slice(0, 20)) {
                        if (existing.has(value)) continue;
                        const anchor = document.createElement('a');
                        anchor.href = value;
                        anchor.setAttribute('data-fgp-method', 'redirect-location');
                        box.appendChild(anchor);
                    }
                }""",
                captured_main_redirects,
            )

        # Playwright's serialized main document does not include cross-origin
        # iframe DOM or open shadow roots. Copy only URL/label attributes from
        # those already-rendered public surfaces into an inert hidden container
        # so the normal extractor can inspect them without executing strings.
        rendered_signals: list[dict[str, str]] = []
        for frame in page.frames:
            try:
                signals = await frame.evaluate(
                    r"""() => {
                        const out = [];
                        const visit = (root) => {
                            for (const el of root.querySelectorAll('a[href],[data-href],[data-url],[data-link],[data-target],[onclick],[formaction]')) {
                                const signal = {
                                    href: el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link') || el.getAttribute('data-target') || el.getAttribute('formaction') || '',
                                    onclick: el.getAttribute('onclick') || '',
                                    label: [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt'), el.className]
                                        .filter(Boolean).join(' ').slice(0, 500)
                                };
                                if (/discord|discordapp|dsc\.gg|invite/i.test(JSON.stringify(signal))) out.push(signal);
                                if (el.shadowRoot) visit(el.shadowRoot);
                                if (out.length >= 100) break;
                            }
                        };
                        visit(document);
                        return out.slice(0, 100);
                    }"""
                )
                rendered_signals.extend(signals or [])
            except Exception:
                continue
        if rendered_signals:
            await page.evaluate(
                """(signals) => {
                    const box = document.createElement('div');
                    box.id = 'fgp-rendered-social-signals';
                    box.hidden = true;
                    for (const signal of signals.slice(0, 200)) {
                        const anchor = document.createElement('a');
                        if (signal.href) anchor.setAttribute('href', signal.href);
                        if (signal.onclick) anchor.setAttribute('onclick', signal.onclick);
                        if (signal.label) anchor.setAttribute('aria-label', signal.label);
                        box.appendChild(anchor);
                    }
                    document.body.appendChild(box);
                }""",
                rendered_signals,
            )
        await page.wait_for_timeout(min(750, DYNAMIC_SETTLE_MS))

    browser_executable = os.environ.get("SCRAPER_BROWSER_EXECUTABLE", "").strip()
    browser_options: dict[str, Any] = {}
    if browser_executable:
        browser_options["executable_path"] = browser_executable
    if pinned_addresses:
        pinned_address = pinned_addresses[0]
        if ":" in pinned_address:
            pinned_address = f"[{pinned_address}]"
        browser_options["extra_flags"] = [
            f"--host-resolver-rules=MAP {approved_host} {pinned_address}, EXCLUDE localhost"
        ]

    fetcher = _load_dynamic_fetcher()
    return await fetcher.async_fetch(
        url,
        headless=True,
        disable_resources=True,
        network_idle=False,
        load_dom=True,
        # Keep a short pre-action wait so inline hydration handlers are attached
        # before the controlled click tier begins. The later waits are skipped
        # adaptively as soon as a complete Discord destination is present.
        wait=min(1_000, DYNAMIC_SETTLE_MS),
        timeout=timeout_ms,
        # Scrapling models this value as the total bounded attempt count and
        # requires at least one. Cross-request retries remain in the Node crawler
        # so they are recorded and coordinated across the whole scan.
        retries=1,
        google_search=False,
        block_ads=False,
        useragent=USER_AGENT,
        page_setup=setup,
        page_action=inspect_full_page,
        **browser_options,
    )


async def scrape_url(
    url: str,
    *,
    timeout_ms: int = 10_000,
    dynamic_fallback: bool = True,
    allow_private: bool = False,
    mode: str = "page",
    force_dynamic: bool = False,
    discovery_mode: str = "discord",
    product_name: str = "Rust NFA accounts",
    product_type: str = "RUST_NFA",
) -> dict[str, Any]:
    _, pinned_addresses = resolve_public_target(url, allow_private=allow_private)
    if force_dynamic:
        dynamic_started = time.perf_counter()
        with DYNAMIC_SLOTS:
            rendered = await _dynamic_page(
                url,
                timeout_ms,
                allow_private=allow_private,
                pinned_addresses=pinned_addresses,
                discovery_mode=discovery_mode,
            )
        return extract_page(
            rendered,
            url,
            fetch_mode="Dynamic",
            duration_ms=int((time.perf_counter() - dynamic_started) * 1000),
            product_name=product_name,
            product_type=product_type,
        )
    started = time.perf_counter()
    session_options: dict[str, Any] = {}
    if pinned_addresses:
        # curl_cffi applies low-level resolver overrides at session creation.
        # Passing curl_options to request() is not supported by the version
        # bundled with Scrapling 0.4.11 and causes every static scan to fail.
        session_options["curl_options"] = {
            CurlOpt.RESOLVE: [_curl_resolve_entry(url, pinned_addresses)]
        }
    session = CurlAsyncSession(**session_options)
    try:
        response = await session.get(
            url,
            timeout=max(1, timeout_ms / 1000),
            allow_redirects=False,
            default_headers=False,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9"},
        )
    finally:
        await session.close()
    page = ResponseFactory.from_http_request(response, {})
    elapsed = int((time.perf_counter() - started) * 1000)
    if mode == "robots":
        if len(page.body) > 500_000:
            raise ScraperError("robots.txt exceeds size limit")
        headers = {str(key).lower(): str(value) for key, value in dict(page.headers or {}).items()}
        redirect = headers.get("location")
        return {
            "requestedUrl": url,
            "finalUrl": str(page.url or url),
            "redirectUrl": urljoin(str(page.url or url), redirect) if redirect else None,
            "httpStatus": int(page.status),
            "contentType": headers.get("content-type", ""),
            "text": page.body.decode("utf-8", errors="replace"),
            "durationMs": elapsed,
        }
    result = extract_page(
        page,
        url,
        fetch_mode="HTTP",
        duration_ms=elapsed,
        product_name=product_name,
        product_type=product_type,
    )
    should_render = bool(
        dynamic_fallback
        and (
            (result["looksDynamic"] and 200 <= result["httpStatus"] < 300)
            or (
                not result["discordLinks"]
                and 200 <= result["httpStatus"] < 300
                and CONTACT_PATH_RE.search(urlparse(str(result["finalUrl"])).path)
            )
            or result["httpStatus"] == 403
            or result["httpStatus"] >= 500
        )
        and result["httpStatus"] != 429
    )
    if should_render:
        dynamic_started = time.perf_counter()
        try:
            # Browser rendering is the expensive tier. Static requests may run
            # broadly in parallel, while Chromium work stays deliberately
            # bounded so a batch cannot exhaust RAM or starve easy domains.
            with DYNAMIC_SLOTS:
                dynamic_url = str(result["finalUrl"])
                _, dynamic_addresses = resolve_public_target(
                    dynamic_url,
                    allow_private=allow_private,
                )
                rendered = await _dynamic_page(
                    dynamic_url,
                    timeout_ms,
                    allow_private=allow_private,
                    pinned_addresses=dynamic_addresses,
                    discovery_mode=discovery_mode,
                )
            result = extract_page(
                rendered,
                url,
                fetch_mode="Dynamic",
                duration_ms=int((time.perf_counter() - dynamic_started) * 1000) + elapsed,
                product_name=product_name,
                product_type=product_type,
            )
        except Exception as error:
            result["dynamicFetchResult"] = "FAILED"
            result["dynamicError"] = f"{type(error).__name__}: {error}"[:500]
    return result


def _retry_after_seconds(headers: dict[str, str]) -> int | None:
    value = headers.get("retry-after", "").strip()
    if value.isdigit():
        return max(0, min(300, int(value)))
    if value:
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            delay = int((retry_at - datetime.now(timezone.utc)).total_seconds())
            return max(0, min(300, delay))
        except (TypeError, ValueError, OverflowError):
            pass
    return None


class InternalHandler(BaseHTTPRequestHandler):
    server_version = "FGPScrapling/1.0"

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller may have cancelled a slow request. Do not turn that
            # ordinary cancellation into another worker failure or noisy trace.
            return

    def _authorized(self) -> bool:
        expected = configured_scraper_token()
        return self.client_address[0] in {"127.0.0.1", "::1"} and self.headers.get("Authorization") == f"Bearer {expected}"

    def do_GET(self) -> None:
        if self.path != "/internal/health":
            self._json(404, {"error": "Not found"})
            return
        if not self._authorized():
            self._json(401, {"error": "Unauthorized"})
            return
        self._json(200, {"ok": True, "engine": "Scrapling", "serviceVersion": SERVICE_VERSION, "scraplingVersion": _package_version()})

    def do_POST(self) -> None:
        if self.path != "/internal/scrape":
            self._json(404, {"error": "Not found"})
            return
        if not self._authorized():
            self._json(401, {"error": "Unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_REQUEST_BYTES:
                raise ScraperError("Invalid request size")
            body = json.loads(self.rfile.read(length))
            requested_url = str(body.get("url", ""))
            hostname = (urlparse(requested_url).hostname or "").lower()
            with HOST_LOCKS_GUARD:
                host_lock = HOST_LOCKS.setdefault(hostname, threading.Lock())
            # Never let HTTP handler threads wait invisibly until the caller's
            # deadline expires. A short admission window returns a retryable 503
            # so the central crawler can back off and reduce concurrency.
            admission_seconds = max(
                0.1,
                min(2.0, int(body.get("timeoutMs", 10_000)) / 10_000),
            )
            global_acquired = GLOBAL_SLOTS.acquire(timeout=admission_seconds)
            if not global_acquired:
                self._json(
                    503,
                    {
                        "ok": False,
                        "error": "Scrapling worker busy; global capacity is full",
                        "retryAfterSeconds": 1,
                    },
                )
                return
            host_acquired = False
            try:
                host_acquired = host_lock.acquire(timeout=admission_seconds)
                if not host_acquired:
                    self._json(
                        503,
                        {
                            "ok": False,
                            "error": "Scrapling worker busy; this host already has an active request",
                            "retryAfterSeconds": 1,
                        },
                    )
                    return
                result = asyncio.run(
                    scrape_url(
                        requested_url,
                        timeout_ms=max(2_000, min(60_000, int(body.get("timeoutMs", 10_000)))),
                        dynamic_fallback=bool(body.get("dynamicFallback", True)),
                        force_dynamic=bool(body.get("forceDynamic", False)),
                        discovery_mode="rust-price" if body.get("discoveryMode") == "rust-price" else "discord",
                        product_name=str(body.get("productName") or "Rust NFA accounts")[:120],
                        product_type=str(body.get("productType") or "RUST_NFA")[:30],
                        mode="robots" if body.get("mode") == "robots" else "page",
                    )
                )
            finally:
                if host_acquired:
                    host_lock.release()
                GLOBAL_SLOTS.release()
            self._json(200, {"ok": True, "result": result})
        except (ScraperError, ValueError, TypeError, json.JSONDecodeError) as error:
            self._json(400, {"ok": False, "error": str(error)})
        except (TimeoutError, CurlTimeout) as error:
            self._json(
                504,
                {
                    "ok": False,
                    "code": "TIMEOUT",
                    "error": f"Timeout: {error}",
                    "retryAfterSeconds": 1,
                },
            )
        except CurlDNSError as error:
            self._json(
                502,
                {
                    "ok": False,
                    "code": "DNS_FAILURE",
                    "error": f"DNS lookup failed: {error}",
                    "retryAfterSeconds": 1,
                },
            )
        except CurlSSLError as error:
            self._json(
                502,
                {
                    "ok": False,
                    "code": "TLS_FAILURE",
                    "error": f"TLS handshake failed: {error}",
                },
            )
        except CurlConnectionError as error:
            self._json(
                502,
                {
                    "ok": False,
                    "code": "CONNECTION_FAILURE",
                    "error": f"Connection failed: {error}",
                    "retryAfterSeconds": 1,
                },
            )
        except Exception as error:
            print(f"Scrapling request failed: {error!r}", file=sys.stderr, flush=True)
            self._json(502, {"ok": False, "error": f"Scrapling worker error: {type(error).__name__}: {error}"})

    def log_message(self, format_string: str, *args: Any) -> None:
        if os.environ.get("SCRAPER_LOG_REQUESTS") == "1":
            super().log_message(format_string, *args)


def _package_version() -> str:
    from importlib.metadata import version

    return version("scrapling")


def main() -> None:
    configured_scraper_token()
    host = "127.0.0.1"
    port = int(os.environ.get("SCRAPER_PORT", "3011"))
    server = ThreadingHTTPServer((host, port), InternalHandler)
    print(f"FGP Scrapling {_package_version()} healthy on http://{host}:{port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
