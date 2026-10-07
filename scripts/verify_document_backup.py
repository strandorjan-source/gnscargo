#!/usr/bin/env python3
"""Verify a document backup before an isolated restoration drill.

Manifest: {"documents": [{"storage_path": "<order uuid>/<document uuid>",
"byte_size": 123, "sha256": "..."}]}. Files live under <backup>/files/.
Does not connect to or modify Supabase, and is NOT a database backup tool.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from uuid import UUID


def verify(directory: Path) -> int:
    directory = directory.resolve()
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    documents = manifest.get("documents")
    if not isinstance(documents, list):
        raise ValueError("Manifest must contain a documents array")
    seen: set[str] = set()
    for item in documents:
        name = item["storage_path"]
        parts = name.split("/")
        if len(parts) != 2 or any(str(UUID(part)) != part for part in parts):
            raise ValueError("Invalid document path")
        if name in seen:
            raise ValueError("Duplicate document path")
        seen.add(name)
        file = (directory / "files" / name).resolve()
        if not file.is_relative_to(directory / "files"):
            raise ValueError("Document path escaped backup folder")
        if not file.is_file() or file.stat().st_size != int(item["byte_size"]):
            raise ValueError(f"Missing file or wrong size: {name}")
        with file.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != item["sha256"]:
            raise ValueError(f"Checksum mismatch: {name}")
    return len(documents)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    try:
        count = verify(arguments.directory)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"BACKUP VALIDATION FAILED: {error}\n")
    print(f"PASS: {count} document files match the manifest. A full database restore remains a separate check.")
