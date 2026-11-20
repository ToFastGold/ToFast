"""Entry point: `python -m jarvis_pc`."""

from __future__ import annotations

import logging
from pathlib import Path

from dotenv import load_dotenv


def main() -> None:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from jarvis_pc.bot import JarvisBot

    JarvisBot().run()


if __name__ == "__main__":
    main()
