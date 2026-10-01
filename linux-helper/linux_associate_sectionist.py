#!/usr/bin/env python3
"""Sectionist Linux file-association helper.

Published as a standalone release asset (Releases/linux_associate_sectionist.py) — not
bundled inside Sectionist itself, and never run automatically. Whether a user wants
Sectionist registered as the handler for .txt/.md (or other) files is entirely up to
them; this script only ever prints information until the user explicitly opts in, and
asks for a final confirmation before writing anything to disk.

Requires only the Python 3 standard library so it runs on any desktop Linux system
without setup.
"""

import mimetypes
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

DESKTOP_FILE_NAME = "sectionist.desktop"
DEFAULT_MIME_TYPES = ["text/plain", "text/markdown"]

APPIMAGE_MAGIC_TYPE1 = b"AI\x01"
APPIMAGE_MAGIC_TYPE2 = b"AI\x02"

INFO_DEB_RPM = """\
================================================================================
 If you installed Sectionist via the .deb or .rpm package
================================================================================
Installing either package already registers Sectionist as a handler for
.txt and .md files automatically — the installer places a desktop entry at
/usr/share/applications/sectionist.desktop with a line like:

    MimeType=text/plain;text/markdown;

Nothing further should be needed. If double-clicking a .txt/.md file still
doesn't open Sectionist, you can redo the registration step yourself:

    xdg-mime default sectionist.desktop text/plain text/markdown
    update-desktop-database ~/.local/share/applications   # or the system path
                                                            # your desktop uses
"""

INFO_APPIMAGE = """\
================================================================================
 If you're running the AppImage
================================================================================
An AppImage does not register itself with your desktop just by existing —
something has to install a desktop entry and tell your system's MIME
database about it. You can do this by hand:

  1. Extract the AppImage to see its bundled desktop entry:
       ./Sectionist_*.AppImage --appimage-extract
       cat squashfs-root/*.desktop
  2. Copy that file to ~/.local/share/applications/sectionist.desktop (or
     $XDG_DATA_HOME/applications/ if you have that set), and edit its Exec=
     line to point at the actual path of your AppImage file.
  3. Add a MimeType line:
       MimeType=text/plain;text/markdown;
  4. Register it:
       update-desktop-database ~/.local/share/applications
       xdg-mime default sectionist.desktop text/plain text/markdown

Alternatively, a tool like AppImageLauncher or appimaged can do all of this
for you automatically the first time you run the AppImage through them.
"""


def ask_yes_no(prompt: str, default: bool = False) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    answer = input(f"{prompt} {suffix} ").strip().lower()
    if not answer:
        return default
    return answer in ("y", "yes")


def xdg_data_home() -> Path:
    value = os.environ.get("XDG_DATA_HOME")
    return Path(value) if value else Path.home() / ".local" / "share"


def find_system_install() -> str | None:
    for name in ("sectionist", "Sectionist"):
        found = shutil.which(name)
        if found:
            return found
    for candidate in ("/usr/bin/Sectionist", "/usr/bin/sectionist"):
        if Path(candidate).exists():
            return candidate
    return None


def find_appimage_arg() -> str | None:
    return sys.argv[1] if len(sys.argv) > 1 else None


def looks_like_appimage(path: Path) -> bool:
    """Best-effort check, not a hard guarantee — used to warn, not to hard-block."""
    if path.suffix.lower() == ".appimage":
        return True
    try:
        with path.open("rb") as f:
            header = f.read(12)
    except OSError:
        return False
    if len(header) < 11 or header[:4] != b"\x7fELF":
        return False
    return header[8:11] in (APPIMAGE_MAGIC_TYPE1, APPIMAGE_MAGIC_TYPE2)


def unshell_path(raw: str) -> str:
    """Undo shell-style quoting/escaping (e.g. from a terminal's tab-completion or a
    drag-and-drop that inserts a quoted/backslash-escaped path) that a user might paste
    into a plain input() prompt, which never goes through a shell and so never strips
    it on its own."""
    s = raw.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        s = s[1:-1]
    return re.sub(r"\\(.)", r"\1", s)


def resolve_and_validate_appimage(raw_path: str) -> str | None:
    raw_path = raw_path.strip()
    resolved = Path(raw_path).expanduser()
    if not resolved.is_file():
        unescaped = unshell_path(raw_path)
        candidate = Path(unescaped).expanduser() if unescaped != raw_path else None
        if candidate is not None and candidate.is_file():
            print(f"(Interpreting that as: {candidate})")
            resolved = candidate
        else:
            print(f"Could not find a file at: {resolved}")
            return None
    resolved = resolved.resolve()

    if not looks_like_appimage(resolved):
        print(
            f"'{resolved.name}' doesn't have a .AppImage extension and doesn't look "
            "like an AppImage (no AppImage header found in the file itself)."
        )
        if not ask_yes_no("Continue anyway?"):
            return None

    if not os.access(resolved, os.X_OK):
        print(
            f"'{resolved.name}' isn't marked executable — this is the most common "
            "reason double-clicking an AppImage silently does nothing."
        )
        if ask_yes_no("Mark it executable now?", default=True):
            try:
                resolved.chmod(resolved.stat().st_mode | 0o111)
                print("Done — executable bit set.")
            except OSError as e:
                print(f"Warning: couldn't set the executable bit: {e}")

    return str(resolved)


def prompt_for_appimage_path() -> str | None:
    path = input(
        "Enter the full path to your Sectionist AppImage file (or leave blank to cancel): "
    ).strip()
    if not path:
        return None
    return resolve_and_validate_appimage(path)


def choose_mime_types() -> list[str]:
    mime_types: list[str] = []

    if ask_yes_no("Associate .txt and .md files with Sectionist?", default=True):
        mime_types.extend(DEFAULT_MIME_TYPES)

    print()
    raw = input(
        'Add any other file types? Enter extensions separated by spaces (e.g. ".png '
        '.jpg"), or leave blank to skip: '
    ).strip()
    if raw:
        for token in raw.split():
            ext = token if token.startswith(".") else f".{token}"
            guessed, _ = mimetypes.guess_type(f"x{ext}")
            if guessed:
                print(f"  {ext} -> {guessed}")
                if guessed not in mime_types:
                    mime_types.append(guessed)
            else:
                print(
                    f"  Don't recognize a standard MIME type for '{ext}'. Linux file "
                    "associations work by MIME type, not extension — if you know the "
                    f"correct one (try `xdg-mime query filetype somefile{ext}` on an "
                    "existing file of that type), you can enter it below."
                )
                manual = input(
                    f"  MIME type for {ext} (or leave blank to skip this extension): "
                ).strip()
                if manual and manual not in mime_types:
                    mime_types.append(manual)

    return mime_types


def read_existing_association(desktop_file: Path) -> tuple[str | None, str | None]:
    try:
        text = desktop_file.read_text()
    except OSError:
        return None, None
    exec_match = re.search(r"^Exec=(.*)$", text, re.MULTILINE)
    mime_match = re.search(r"^MimeType=(.*)$", text, re.MULTILINE)
    return (
        exec_match.group(1) if exec_match else None,
        mime_match.group(1) if mime_match else None,
    )


def register_existing_install(exec_path: str) -> None:
    print()
    print(f"Found an existing Sectionist install at: {exec_path}")
    print("This should already be registered — this will just re-run the")
    print("registration commands in case it didn't take effect.")
    print()
    print("Commands to be run:")
    print("  xdg-mime default sectionist.desktop text/plain text/markdown")
    print("  update-desktop-database <applications dir>")
    if not ask_yes_no("Proceed?"):
        print("Cancelled — no changes made.")
        return
    apps_dir = xdg_data_home() / "applications"
    run_registration_commands(apps_dir, DEFAULT_MIME_TYPES)


def register_appimage(appimage_path: str, mime_types: list[str]) -> None:
    apps_dir = xdg_data_home() / "applications"
    desktop_file = apps_dir / DESKTOP_FILE_NAME
    mime_type_line = ";".join(mime_types) + ";"
    content = (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Sectionist\n"
        f'Exec="{appimage_path}" %f\n'
        f"MimeType={mime_type_line}\n"
        "Terminal=false\n"
        "Icon=sectionist\n"
        "Categories=Utility;TextEditor;\n"
    )

    if desktop_file.exists():
        existing_exec, existing_mime = read_existing_association(desktop_file)
        if existing_exec or existing_mime:
            print()
            print("Found an existing Sectionist association:")
            if existing_exec:
                print(f"  Exec:     {existing_exec}")
            if existing_mime:
                print(f"  MimeType: {existing_mime}")
            print("This will be replaced with the configuration below.")

    print()
    print("This will write the following file:")
    print(f"  {desktop_file}")
    print("--------------------------------------------------------------------------------")
    print(content, end="")
    print("--------------------------------------------------------------------------------")
    print("Then run:")
    print(f"  update-desktop-database {apps_dir}")
    print(f"  xdg-mime default {DESKTOP_FILE_NAME} {' '.join(mime_types)}")
    print()
    if not ask_yes_no("Proceed?"):
        print("Cancelled — no changes made.")
        return

    apps_dir.mkdir(parents=True, exist_ok=True)
    desktop_file.write_text(content)
    print(f"Wrote {desktop_file}")
    run_registration_commands(apps_dir, mime_types)


def run_registration_commands(apps_dir: Path, mime_types: list[str]) -> None:
    try:
        subprocess.run(["update-desktop-database", str(apps_dir)], check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"Warning: update-desktop-database failed: {e}")

    try:
        subprocess.run(
            ["xdg-mime", "default", DESKTOP_FILE_NAME, *mime_types], check=True
        )
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"Warning: xdg-mime failed: {e}")
        return

    print()
    print("Done. Sectionist should now open for the file types you selected.")


def main() -> None:
    print(INFO_DEB_RPM)
    print(INFO_APPIMAGE)

    if not ask_yes_no("Would you like this script to set up file associations for you now?"):
        print("No changes made.")
        return

    system_install = find_system_install()
    if system_install:
        register_existing_install(system_install)
        return

    appimage_path = find_appimage_arg()
    if appimage_path:
        appimage_path = resolve_and_validate_appimage(appimage_path)

    if not appimage_path:
        appimage_path = prompt_for_appimage_path()

    if not appimage_path:
        print("No AppImage path given — no changes made.")
        return

    mime_types = choose_mime_types()
    if not mime_types:
        print("No file types selected — no changes made.")
        return

    register_appimage(appimage_path, mime_types)


if __name__ == "__main__":
    main()
