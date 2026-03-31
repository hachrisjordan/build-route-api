#!/usr/bin/env python3
"""
AmEx Cookie Fetcher using undetected-chromedriver

Flow:
- Opens the AmEx luxury hotel offers page in a real Chromium (undetected-chromedriver).
- You solve any challenges / log in if needed.
- Script reads cookies for americanexpress.com and saves:
  - Locally to amex_cookies.json
  - Into Supabase `program` table row with code = 'AMEX' (cookies JSONB column)

Later, Node/Next.js code can build the AMEX_COOKIE header from those stored cookies.
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---- Env loading (reuse project .env) ---------------------------------------

try:
    from dotenv import load_dotenv

    project_root = Path(__file__).resolve().parents[1]
    env_path = project_root / ".env"
    load_dotenv(str(env_path))
    print(f"✅ Environment variables loaded from: {env_path}")
except Exception as e:  # pragma: no cover - best-effort env load
    print(f"⚠️  Could not load .env file: {e}")
    print("Will rely on process environment variables.")

# ---- Supabase integration ---------------------------------------------------

try:
    from supabase import Client, create_client

    SUPABASE_AVAILABLE = True
except ImportError:
    print("⚠️  Supabase client not installed. Run `pip install supabase-py` to enable DB storage.")
    SUPABASE_AVAILABLE = False
    Client = Any  # type: ignore


class AmexSupabaseManager:
    """Minimal Supabase manager for storing AmEx cookies in the `program` table."""

    def __init__(self) -> None:
        self.client: Optional[Client] = None
        self.initialized = False

        if not SUPABASE_AVAILABLE:
            return

        self._init_client()

    def _init_client(self) -> None:
        try:
            url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
            key = (
                os.getenv("SUPABASE_SERVICE_ROLE_KEY")
                or os.getenv("SUPABASE_ANON_KEY")
                or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
            )
            if not url or not key:
                print("⚠️  Missing Supabase URL / key; AmEx cookies will not be persisted to DB.")
                return

            self.client = create_client(url, key)
            self.initialized = True
            print("✅ Supabase client initialised for AmEx cookies")
        except Exception as e:  # pragma: no cover - defensive
            print(f"❌ Failed to create Supabase client: {e}")

    def update_amex_cookies(self, cookies: List[Dict[str, Any]]) -> bool:
        """Upsert cookies into program row with code='AMEX'."""
        if not self.initialized or not self.client:
            return False

        try:
            result = (
                self.client.table("program")
                .update({"cookies": cookies})
                .eq("code", "AMEX")
                .execute()
            )
            if result.data:
                print("✅ AmEx cookies updated in Supabase (program.code = 'AMEX')")
                return True

            # If no row updated, try insert
            insert = (
                self.client.table("program")
                .insert({"code": "AMEX", "cookies": cookies})
                .execute()
            )
            if insert.data:
                print("✅ AmEx cookies inserted in Supabase (program.code = 'AMEX')")
                return True

            print("⚠️  Supabase did not return data when updating/inserting AmEx cookies")
            return False
        except Exception as e:
            print(f"❌ Failed to write AmEx cookies into Supabase: {e}")
            return False


# ---- undetected-chromedriver bootstrap (with distutils patch) --------------


def patch_distutils_and_import_uc():
    """Handle Python 3.13+ where distutils is missing, mirroring Finnair script."""
    try:
        import undetected_chromedriver as uc  # type: ignore

        return uc
    except ImportError as e:
        if "distutils" not in str(e):
            print(f"❌ Could not import undetected_chromedriver: {e}")
            print("   pip install undetected-chromedriver")
            sys.exit(1)

        print("⚠️  Python 3.13+ distutils issue detected – applying shim...")
        import types

        mock_distutils = types.ModuleType("distutils")
        mock_distutils.version = types.ModuleType("distutils.version")

        class LooseVersion:
            def __init__(self, version_string: str) -> None:
                self.version_string = str(version_string)
                self.version = self.version_string
                self.vstring = self.version_string

            def __str__(self) -> str:
                return self.version_string

        mock_distutils.version.LooseVersion = LooseVersion  # type: ignore[attr-defined]
        sys.modules["distutils"] = mock_distutils
        sys.modules["distutils.version"] = mock_distutils.version

        print("✅ distutils shim installed, retrying uc import...")
        import undetected_chromedriver as uc  # type: ignore

        return uc


uc = patch_distutils_and_import_uc()


class AmexCookieManager:
    """Handles opening AmEx page, capturing cookies, and persisting them."""

    def __init__(self, cookies_file: str = "amex_cookies.json") -> None:
        self.cookies_file = Path(cookies_file)
        self.driver = None
        self.supabase_manager = AmexSupabaseManager()

    # ---- driver setup ------------------------------------------------------

    def setup_driver(self, headless: bool = False):
        """Configure undetected-chromedriver with Docker-friendly flags."""
        try:
            options = uc.ChromeOptions()

            # Best-effort Chrome binary discovery
            chrome_bin = os.getenv("CHROME_BIN")
            if not chrome_bin:
                for path in [
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                    "/usr/bin/google-chrome",
                    "/usr/bin/chromium-browser",
                ]:
                    if os.path.exists(path):
                        chrome_bin = path
                        break
            if chrome_bin and os.path.exists(chrome_bin):
                options.binary_location = chrome_bin

            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--disable-gpu")
            options.add_argument("--disable-extensions")
            options.add_argument("--disable-blink-features=AutomationControlled")
            options.add_argument("--user-data-dir=/tmp/amex-chrome-data")

            if headless:
                options.add_argument("--headless=new")

            self.driver = uc.Chrome(options=options, headless=headless)
            self.driver.execute_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            print("✅ Chrome driver initialised for AmEx")
            return self.driver
        except Exception as e:  # pragma: no cover - outside tests
            print(f"❌ Failed to initialise Chrome driver: {e}")
            return None

    # ---- cookie capture ----------------------------------------------------

    def _filter_amex_cookies(self, cookies: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Keep only cookies relevant for AmEx bot/auth flows."""
        if not cookies:
            return []

        important_names = ["ts", "_abck", "agent-id", "ak_bmsc", "bm_sz"]
        filtered: List[Dict[str, Any]] = []

        for cookie in cookies:
            name = str(cookie.get("name", "")).lower()
            domain = str(cookie.get("domain", "")).lower()

            if "americanexpress.com" not in domain:
                continue

            if any(key in name for key in important_names):
                filtered.append(cookie)
                continue

            # Fallback: keep all AmEx-domain cookies if we have very few
            filtered.append(cookie)

        print(f"🔎 Filtered {len(filtered)} AmEx cookies out of {len(cookies)} total")
        return filtered

    def save_cookies(self) -> bool:
        """Save AmEx cookies to file and Supabase."""
        if not self.driver:
            print("❌ No driver instance; call setup_driver() first.")
            return False

        try:
            # Ensure we are on an AmEx page so cookies are in scope
            target_url = (
                "https://www.americanexpress.com/en-us/travel/offers/hotels/"
                "luxury-hotel-offers?intlink=us-travel-fhr-explore-offers"
            )
            print(f"🌐 Navigating to {target_url} to read cookies...")
            self.driver.get(target_url)
            time.sleep(5)

            raw_cookies = self.driver.get_cookies()
            amex_cookies = self._filter_amex_cookies(raw_cookies)

            if not amex_cookies:
                print("⚠️  No AmEx cookies captured; are you sure the page finished loading?")
                return False

            # Persist locally
            self.cookies_file.parent.mkdir(parents=True, exist_ok=True)
            with self.cookies_file.open("w") as f:
                json.dump(amex_cookies, f, indent=2)
            print(f"✅ Saved {len(amex_cookies)} AmEx cookies to {self.cookies_file}")

            # Persist to Supabase
            if self.supabase_manager.update_amex_cookies(amex_cookies):
                print("✅ AmEx cookies saved to Supabase as well")
            else:
                print("⚠️  Skipped Supabase cookie storage (client missing or error).")

            return True
        except Exception as e:
            print(f"❌ Error while saving AmEx cookies: {e}")
            return False

    # ---- interactive flow --------------------------------------------------

    def manual_login_flow(self) -> None:
        """Open AmEx offers page and let user handle any challenges/login, then capture cookies."""
        if not self.driver:
            raise RuntimeError("Driver not initialised")

        target_url = (
            "https://www.americanexpress.com/en-us/travel/offers/hotels/"
            "luxury-hotel-offers?intlink=us-travel-fhr-explore-offers"
        )
        print("1️⃣ Opening AmEx Luxury Hotel Offers page in a real browser...")
        self.driver.get(target_url)
        time.sleep(5)

        print("\n2️⃣ In the browser window:")
        print("   - Solve any challenges / captchas.")
        print("   - Log in if AmEx requires it.")
        print("   - Wait until hotel offers / content load.")
        input("3️⃣ When the page looks stable, press Enter here to capture cookies...")

        print("4️⃣ Capturing cookies...")
        if self.save_cookies():
            print("🎉 AmEx cookies captured and stored. You can now use them from Node.")
        else:
            print("❌ Failed to capture AmEx cookies. Try again after ensuring the page fully loads.")

    # ---- lifecycle ---------------------------------------------------------

    def quit(self) -> None:
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="AmEx cookie automation using undetected-chromedriver")
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run Chrome in headless mode (only use once flow is stable).",
    )
    args = parser.parse_args()

    manager = AmexCookieManager(cookies_file=str(Path(__file__).with_name("amex_cookies.json")))
    try:
        driver = manager.setup_driver(headless=args.headless)
        if not driver:
            sys.exit(1)

        manager.manual_login_flow()
    finally:
        manager.quit()


if __name__ == "__main__":
    main()

