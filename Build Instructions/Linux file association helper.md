# Linux File Association Helper

Sectionist can be opened directly from an OS file association ("double-click a .txt or
.md file to open it in Sectionist"). On Linux, how that gets registered depends on how
Sectionist was installed:

- **`.deb` / `.rpm`**: registration is automatic. Installing either package installs a
  desktop entry (`/usr/share/applications/sectionist.desktop`) with a
  `MimeType=text/plain;text/markdown;` line, and the package manager refreshes the
  desktop/MIME databases as part of installing it. Nothing further is needed.
- **AppImage**: registration is **not** automatic. An AppImage does not register
  itself with the desktop just by existing — something has to install a desktop entry
  and tell the system's MIME database about it. This is standard AppImage behavior
  (not a Sectionist bug), and is normally handled by a tool like
  [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) or
  [`appimaged`](https://github.com/probonopd/go-appimage), by hand (see below), or via
  the helper script described here.

Whether to run any of this is entirely up to the user — Sectionist itself never
touches desktop files or the MIME database, and doesn't bundle or invoke this script.
Registering (or not) an AppImage this way is a one-time, user-initiated choice.

## The helper script

`linux-helper/linux_associate_sectionist.py` (published alongside the `.deb`/`.rpm`/AppImage
bundles in `Releases/`) automates the manual steps below. It's plain Python 3 with no
dependencies beyond the standard library, so it runs on any desktop Linux system
without extra setup:

```bash
python3 linux_associate_sectionist.py                       # searches for an AppImage path
python3 linux_associate_sectionist.py /path/to/Sectionist.AppImage
```

It always starts by printing two sections — what a `.deb`/`.rpm` install already gets
automatically, and what an AppImage user could do by hand — before asking whether to
proceed. It makes **no filesystem changes** unless the user answers yes to that
prompt, and even then it prints the exact file path/contents and commands it's about
to run and asks for one more confirmation before writing anything. It respects
`$XDG_DATA_HOME` (falling back to `~/.local/share`) and only ever writes to the
user's own data directory — never a system-wide path, never via `sudo`.

For the AppImage path specifically, it also:
- Checks that the file it's given actually looks like an AppImage (its `.AppImage`
  extension, or failing that the AppImage magic bytes) before proceeding — warning and
  asking for confirmation rather than hard-failing, since the check is a heuristic.
- Checks the file's executable bit and offers to `chmod +x` it on the spot if it's
  missing, since a non-executable AppImage silently doing nothing on double-click is
  the most common AppImage complaint (see the AppImage build guide's troubleshooting
  section).
- If Sectionist is already associated with something (e.g. an older AppImage from a
  previous version), it shows the existing `Exec=`/`MimeType=` values before asking to
  replace them — so re-running the script after upgrading to a new AppImage is always
  safe and explicit about what's changing.
- Asks which file types to associate: `.txt`/`.md` by default, plus any other
  extensions you want (e.g. `.png` so image files show up as non-editable file links
  in Sectionist, matching how `Store.addFileToSection` already only makes plain
  text/Markdown files the active file). Extra extensions are resolved to a MIME type
  via Python's standard `mimetypes` module; if it doesn't recognize one, the script
  asks you to supply the MIME type yourself or skip that extension.

## Removing associations

`linux-helper/linux_remove_associations.py` (also published in `Releases/`) is the
counterpart to the helper script above: it looks for whatever file-type associations
Sectionist currently has registered for your user account — reading the `MimeType=`
line from `~/.local/share/applications/sectionist.desktop` (or `$XDG_DATA_HOME`) and
any `text/foo=sectionist.desktop` entries in `~/.config/mimeapps.list`'s `[Default
Applications]` section — and asks, one association at a time, whether to remove it.
If removing the selected associations would leave the desktop entry with no file
types left, it also offers to delete `sectionist.desktop` itself. Like the setup
script, it prints the exact changes before a final confirmation and never touches a
system-wide install (that's managed by your package manager instead) or another
application's own "Open With" registrations.

```bash
python3 linux_remove_associations.py
```

## Manual steps (if you'd rather not run the script)

1. Extract the AppImage to see its bundled desktop entry:
   ```bash
   ./Sectionist_*.AppImage --appimage-extract
   cat squashfs-root/*.desktop
   ```
2. Copy that file to `~/.local/share/applications/sectionist.desktop` (or
   `$XDG_DATA_HOME/applications/` if set), and edit its `Exec=` line to point at the
   actual path of your AppImage file.
3. Add a MIME type line: `MimeType=text/plain;text/markdown;`
4. Register it:
   ```bash
   update-desktop-database ~/.local/share/applications
   xdg-mime default sectionist.desktop text/plain text/markdown
   ```

## Publishing the script with a release

The script is plain source, not a build artifact — no compilation step. When cutting a
release, copy it into `Releases/` alongside the bundles:

```bash
cp linux-helper/linux_associate_sectionist.py "Releases/"
cp linux-helper/linux_remove_associations.py "Releases/"
```
