#!/usr/bin/env python3
"""Sectionist Linux file-association remover.

Published as a standalone release asset (Releases/linux_remove_associations.py) — the
counterpart to linux_associate_sectionist.py. Finds whatever file-type associations
Sectionist currently has registered for your user account (from running
linux_associate_sectionist.py, or similar manual setup) and asks, one at a time, which ones
to remove. Makes no filesystem changes until you confirm each one, and prints exactly
what it's about to write before a final confirmation. Only ever touches your own user
data directory — never a system-wide path, never via sudo.

Requires only the Python 3 standard library so it runs on any desktop Linux system
without setup.
"""

import os
import re
import subprocess
from pathlib import Path

DESKTOP_FILE_NAME = "sectionist.desktop"
SYSTEM_DESKTOP_PATHS = [
    Path("/usr/share/applications") / DESKTOP_FILE_NAME,
    Path("/usr/local/share/applications") / DESKTOP_FILE_NAME,
]


def ask_yes_no(prompt: str, default: bool = False) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    answer = input(f"{prompt} {suffix} ").strip().lower()
    if not answer:
        return default
    return answer in ("y", "yes")


def xdg_data_home() -> Path:
    value = os.environ.get("XDG_DATA_HOME")
    return Path(value) if value else Path.home() / ".local" / "share"


def xdg_config_home() -> Path:
    value = os.environ.get("XDG_CONFIG_HOME")
    return Path(value) if value else Path.home() / ".config"


def user_desktop_file() -> Path:
    return xdg_data_home() / "applications" / DESKTOP_FILE_NAME


def mimeapps_path() -> Path:
    return xdg_config_home() / "mimeapps.list"


def find_system_desktop_file() -> Path | None:
    for path in SYSTEM_DESKTOP_PATHS:
        if path.exists():
            return path
    return None


def read_desktop_mime_types(desktop_file: Path) -> list[str]:
    try:
        text = desktop_file.read_text()
    except OSError:
        return []
    match = re.search(r"^MimeType=(.*)$", text, re.MULTILINE)
    if not match:
        return []
    return [m for m in match.group(1).split(";") if m]


def read_mimeapps_defaults(path: Path) -> list[tuple[str, list[str]]]:
    """Every [Default Applications] line whose ids include sectionist.desktop."""
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    section = None
    results = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1]
            continue
        if section != "Default Applications" or "=" not in stripped:
            continue
        mimetype, _, value = stripped.partition("=")
        ids = [v for v in value.split(";") if v]
        if DESKTOP_FILE_NAME in ids:
            results.append((mimetype.strip(), ids))
    return results


def update_mimeapps(path: Path, to_remove: set[str]) -> None:
    try:
        lines = path.read_text().splitlines()
    except OSError as e:
        print(f"Warning: couldn't read {path}: {e}")
        return

    section = None
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1]
            new_lines.append(line)
            continue
        if section == "Default Applications" and "=" in stripped:
            mimetype, _, value = stripped.partition("=")
            if mimetype.strip() in to_remove:
                ids = [v for v in value.split(";") if v and v != DESKTOP_FILE_NAME]
                if ids:
                    new_lines.append(f"{mimetype.strip()}={';'.join(ids)};")
                continue
        new_lines.append(line)

    try:
        path.write_text("\n".join(new_lines) + "\n")
        print(f"Updated {path}")
    except OSError as e:
        print(f"Warning: couldn't write {path}: {e}")


def update_desktop_file_mime_types(desktop_file: Path, to_remove: set[str]) -> None:
    try:
        text = desktop_file.read_text()
    except OSError as e:
        print(f"Warning: couldn't read {desktop_file}: {e}")
        return

    def replace(match: re.Match) -> str:
        types = [t for t in match.group(1).split(";") if t and t not in to_remove]
        return "MimeType=" + ";".join(types) + (";" if types else "")

    new_text = re.sub(r"^MimeType=(.*)$", replace, text, count=1, flags=re.MULTILINE)
    try:
        desktop_file.write_text(new_text)
        print(f"Updated {desktop_file}")
    except OSError as e:
        print(f"Warning: couldn't write {desktop_file}: {e}")


def main() -> None:
    print("=" * 80)
    print(" Sectionist file-association remover")
    print("=" * 80)
    print(
        "This looks for file-type associations Sectionist has registered for your "
        "user account (from running linux_associate_sectionist.py, or similar manual "
        "setup) and lets you remove them one at a time. It doesn't touch a "
        "system-wide install from a .deb/.rpm package or any other application's "
        "own 'Open With' registrations — only what Sectionist's own user-level "
        "desktop entry and default associations declare."
    )
    print()

    system_desktop = find_system_desktop_file()
    if system_desktop:
        print(
            f"Note: found a system-wide desktop entry at {system_desktop} — that was "
            "installed by a package manager (.deb/.rpm) and isn't something this "
            "script can remove. Uninstall the Sectionist package if you want that "
            "gone too."
        )
        print()

    desktop_file = user_desktop_file()
    apps_mimeapps = mimeapps_path()

    desktop_exists = desktop_file.exists()
    desktop_mime_types = read_desktop_mime_types(desktop_file) if desktop_exists else []
    default_entries = read_mimeapps_defaults(apps_mimeapps)
    default_mime_types = [mimetype for mimetype, _ in default_entries]

    all_mime_types = sorted(set(desktop_mime_types) | set(default_mime_types))

    if not all_mime_types and not desktop_exists:
        print("No Sectionist file associations found for your user account.")
        return

    print("Found the following Sectionist file association(s):")
    for mimetype in all_mime_types:
        marker = " (currently set as default)" if mimetype in default_mime_types else ""
        print(f"  - {mimetype}{marker}")
    if not all_mime_types:
        print(f"  (none — {desktop_file} exists but declares no MimeType= values)")
    print()

    to_remove: set[str] = set()
    for mimetype in all_mime_types:
        if ask_yes_no(f"Remove the association for '{mimetype}'?"):
            to_remove.add(mimetype)

    remove_desktop_file = False
    if desktop_exists:
        remaining = [m for m in desktop_mime_types if m not in to_remove]
        if to_remove and not remaining:
            remove_desktop_file = ask_yes_no(
                "No file types would remain associated — also remove the "
                f"{DESKTOP_FILE_NAME} entry itself?",
                default=True,
            )

    if not to_remove and not remove_desktop_file:
        print("Nothing selected — no changes made.")
        return

    print()
    print("The following changes will be made:")
    if to_remove & set(default_mime_types):
        print(f"  Remove from {apps_mimeapps}: {', '.join(sorted(to_remove & set(default_mime_types)))}")
    if desktop_exists:
        if remove_desktop_file:
            print(f"  Delete {desktop_file}")
        elif to_remove & set(desktop_mime_types):
            remaining = [m for m in desktop_mime_types if m not in to_remove]
            print(f"  Update {desktop_file} MimeType= to: {';'.join(remaining)};")
    print()
    if not ask_yes_no("Proceed?"):
        print("Cancelled — no changes made.")
        return

    if to_remove & set(default_mime_types):
        update_mimeapps(apps_mimeapps, to_remove)

    if desktop_exists:
        if remove_desktop_file:
            try:
                desktop_file.unlink()
                print(f"Deleted {desktop_file}")
            except OSError as e:
                print(f"Warning: couldn't delete {desktop_file}: {e}")
        elif to_remove & set(desktop_mime_types):
            update_desktop_file_mime_types(desktop_file, to_remove)

    apps_dir = xdg_data_home() / "applications"
    try:
        subprocess.run(["update-desktop-database", str(apps_dir)], check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"Warning: update-desktop-database failed: {e}")

    print()
    print("Done.")


if __name__ == "__main__":
    main()
