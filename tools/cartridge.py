"""Which cartridge is in `dev/`, for the checks and tools that read one.

The Python half of `tools/cartridge.mjs`, and the same reasoning: five tools
opened `dev/pokecrystal.gbc` by name, which is right for the disassembly and
wrong for everything built from it. A hack's Makefile names its own output.

**The pairing is the careful part, not the globbing.** A symbol file describes
exactly one build -- its addresses are that ROM's memory map -- and handed the
wrong ROM it does not fail, it answers. Every read comes back plausible and
wrong. So a pair is taken when the two names agree, and a pair that has to be
assumed is said out loud.

Deliberately not a second implementation of the JS one's *rules*: both prefer a
matching stem, both fall back to one-of-each with a warning, both refuse to
guess between several. Two readers of one directory that disagreed about which
cartridge is current would be worse than either.
"""
import os
import pathlib

# What a Game Boy ROM is called. `.gb` as well, because a hack targeting the
# mono machine is still a cartridge these can read.
ROM_EXTS = (".gbc", ".gb")


def find_cartridge(dev: pathlib.Path):
    """`(rom, sym, note)` — any of the first two may be None.

    `DEV_ROM` and `DEV_SYM` override the search, which is what makes a run over
    several hacks scriptable without moving files about.
    """
    forced_rom, forced_sym = os.environ.get("DEV_ROM"), os.environ.get("DEV_SYM")
    if forced_rom and forced_sym:
        return pathlib.Path(forced_rom), pathlib.Path(forced_sym), None
    if not dev.is_dir():
        return None, None, None
    roms = sorted((f for f in dev.iterdir() if f.suffix.lower() in ROM_EXTS),
                  key=lambda f: -f.stat().st_mtime)
    syms = sorted(f for f in dev.iterdir() if f.suffix.lower() == ".sym")
    if not roms or not syms:
        return None, None, None
    by_stem = {f.stem: f for f in syms}
    for rom in roms:
        if rom.stem in by_stem:
            note = None if len(roms) == len(syms) == 1 else \
                f"using {rom.name} with {rom.stem}.sym"
            return rom, by_stem[rom.stem], note
    if len(roms) == 1 and len(syms) == 1:
        return roms[0], syms[0], (
            f"{roms[0].name} and {syms[0].name} do not share a name — assuming "
            "they are the same build. A symbol file from another build answers "
            "every read, plausibly and wrongly.")
    return None, None, (
        f"cannot tell which of {len(roms)} ROM(s) goes with which of "
        f"{len(syms)} symbol file(s). Name them alike, or set DEV_ROM/DEV_SYM.")


def cartridge_paths(root: pathlib.Path):
    """The pair, or `(None, None)`. The note is printed if there is one."""
    rom, sym, note = find_cartridge(root / "dev")
    if note:
        print(f"        [cartridge] {note}")
    return rom, sym


# Whether the "cannot pair these" warning has been given. Said once rather than
# per caller: six groups ask this, and six copies of one sentence reads as six
# problems.
_WARNED = []


def has_cartridge(root: pathlib.Path) -> bool:
    """Is there a cartridge to check against at all?

    Quiet when there is simply nothing in `dev/` -- that is the ordinary state
    of a clean checkout and every caller already says it is skipping. **Loud
    when there are files it cannot pair**, because that is a cartridge somebody
    put there expecting it to be used, and a silent skip would read as the
    checks passing.
    """
    rom, sym, note = find_cartridge(root / "dev")
    if note and not rom and not _WARNED:
        _WARNED.append(note)
        print(f"        [cartridge] {note}")
    return bool(rom and sym)
