# FGP Scrapling service

This is an internal, loopback-only worker. The React dashboard and Chrome
extension never call it directly. The Node API validates every initial URL,
redirect, robots URL, and same-domain crawl candidate before this service is
allowed to fetch it.

The service uses Scrapling `AsyncFetcher` by default. `DynamicFetcher` is used
only when Dynamic Fallback is enabled and the static page looks like an empty
JavaScript shell. No proxy rotation, CAPTCHA solving, stealth fetcher, or
anti-bot bypass is enabled.

Setup and startup commands are documented in the repository root README.
