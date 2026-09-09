"""Numbers in the prose that the repository can compute for itself.

Every pass of this project has had to correct one of these by hand, and two
have shipped wrong: `DEVELOPING.md` claimed 143 tests while 576 ran, and the
symbol digest was drawn as 47 entries when it held 53. They go stale for the
same reason every time -- the number lives in prose that nothing recomputes,
one directory away from the thing it counts.

So the table lives here, once, and two tools read it:

    tools/check-app counts     refuse a number that has drifted
    tools/renumber             write the current ones in

One table rather than two, because a writer and a checker that disagree about
what a number means is worse than having neither: the writer would keep
"fixing" the docs into a shape the checker rejects.

Each entry is a claim: a file, a pattern with one capture group, and a function
returning what that capture *should* say. A pattern may match many times and
every match is checked -- the same total is drawn in two diagrams and written
once in prose.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent

WORDS = [
    'nought', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
    'sixteen', 'seventeen', 'eighteen', 'nineteen',
]
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
        'eighty', 'ninety']


def word(n):
    """A number as the prose writes it: twenty-two, forty-one, one hundred."""
    n = int(n)
    if n < 20:
        return WORDS[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return TENS[tens] + (f'-{WORDS[ones]}' if ones else '')
    return str(n)


# --- what the repository can count about itself ------------------------------

def test_counts():
    """{file name: tests in it} for every behaviour test file."""
    return {p.name: len(re.findall(r'^test\(', p.read_text(), re.M))
            for p in sorted((ROOT / 'tests' / 'cases').glob('*.mjs'))}


def check_groups():
    """How many groups `tools/check-app` runs."""
    src = (ROOT / 'tools' / 'check-app').read_text()
    block = src.split('CHECKS = {')[1].split('}')[0]
    return len(re.findall(r'^\s*"[\w-]+":', block, re.M))


def shared_symbols():
    """How many names travel in the digest a second device boots from."""
    src = (ROOT / 'gen2' / 'symbols.js').read_text()
    block = src.split('export const SHARED_SYMBOLS = [')[1].split('];')[0]
    return len(re.findall(r"'[^']+'", block))


AUDIT_ROW = re.compile(r'^\| (\d+) \| .* \| .* \| .*\|$', re.M)


def audit_rows():
    """How many defects the audit table records."""
    return len(AUDIT_ROW.findall((ROOT / 'docs' / 'PROVEN.md').read_text()))


def audit_passes():
    """How many passes those defects came from."""
    rows = AUDIT_ROW.findall((ROOT / 'docs' / 'PROVEN.md').read_text())
    return len({int(n) for n in rows})


def _tests_total():
    return sum(test_counts().values())


def _tests_files():
    return len(test_counts())


# A claim: (file, pattern, what the capture should be). The pattern's one group
# is the number; everything else anchors it to the sentence that carries it.
CLAIMS = [
    ('docs/DEVELOPING.md', r'^(\d+) tests in \d+ files', _tests_total),
    ('docs/DEVELOPING.md', r'^\d+ tests in (\d+) files', _tests_files),
    ('docs/DEVELOPING.md', r'run-tests<br/>(\d+) behaviour tests', _tests_total),
    ('docs/DEVELOPING.md', r'check-app<br/>(\d+) groups', check_groups),
    ('docs/DEVELOPING.md', r'`tools/check-app` is ([a-z-]+) groups',
     lambda: word(check_groups())),
    ('docs/CODE.md', r'<br/>(\d+) entries, ~1KB', shared_symbols),
    ('docs/PROVEN.md', r'and found \*\*(\d+)\*\*', audit_rows),
    ('docs/PROVEN.md', r'\*\*([a-z-]+)\*\*\npasses went looking',
     lambda: word(audit_passes())),
]


def drift():
    """Every claim whose number is not what the repository computes.

    Returns [(file, want, got, context)]. A claim whose pattern matches nothing
    is reported too: a sentence that was reworded out from under its own check
    is exactly how one of these went stale in the first place.
    """
    out = []
    for rel, pattern, compute in CLAIMS:
        text = (ROOT / rel).read_text()
        want = str(compute())
        found = list(re.finditer(pattern, text, re.M))
        if not found:
            out.append((rel, want, None, pattern))
            continue
        for m in found:
            if m.group(1) != want:
                out.append((rel, want, m.group(1),
                            m.group(0).replace('\n', ' ')[:60]))
    # And the per-file rows of the test table, which are a table rather than a
    # sentence and so cannot be one claim.
    doc = (ROOT / 'docs' / 'DEVELOPING.md').read_text()
    listed = {m.group(1): m.group(2) for m in
              re.finditer(r'^\|\s*`([\w.]+\.mjs)`\s*\|\s*(\d+)\s*\|', doc, re.M)}
    real = test_counts()
    for name, n in real.items():
        if name not in listed:
            out.append(('docs/DEVELOPING.md', str(n), None,
                        f'{name} is not in the table'))
        elif listed[name] != str(n):
            out.append(('docs/DEVELOPING.md', str(n), listed[name], name))
    for name in listed:
        if name not in real:
            out.append(('docs/DEVELOPING.md', 'gone', listed[name],
                        f'{name} is in the table and is not a test file'))
    return out


def rewrite():
    """Put the current numbers in. Returns [(file, what changed)]."""
    changed = []
    for rel, pattern, compute in CLAIMS:
        path = ROOT / rel
        text = path.read_text()
        want = str(compute())

        def one(m):
            if m.group(1) == want:
                return m.group(0)
            changed.append((rel, f'{m.group(1)} → {want}'))
            return m.group(0).replace(m.group(1), want, 1)

        new = re.sub(pattern, one, text, flags=re.M)
        if new != text:
            path.write_text(new)
    # The table's rows.
    path = ROOT / 'docs' / 'DEVELOPING.md'
    text = path.read_text()
    real = test_counts()

    def row(m):
        name, was = m.group(1), m.group(2)
        if name not in real or was == str(real[name]):
            return m.group(0)
        changed.append(('docs/DEVELOPING.md', f'{name} {was} → {real[name]}'))
        return f'| `{name}` | {real[name]} |'

    text = re.sub(r'^\|\s*`([\w.]+\.mjs)`\s*\|\s*(\d+)\s*\|', row, text,
                  flags=re.M)

    # **A file the table has never heard of gets a row.** This could only
    # update numbers at first, so a *new* test file left the check failing with
    # nothing the writer could do about it -- which is the state a check
    # somebody edits around ends up in. The description is left as a dash on
    # purpose: what a file pins down is the one thing here that cannot be
    # computed, and a placeholder asks for it plainly.
    listed = set(re.findall(r'^\|\s*`([\w.]+\.mjs)`', text, re.M))
    for name in sorted(set(real) - listed):
        rows = list(re.finditer(r'^\|\s*`[\w.]+\.mjs`\s*\|.*\|$', text, re.M))
        if not rows:
            break
        at = rows[-1].end()
        text = text[:at] + f'\n| `{name}` | {real[name]} | — |' + text[at:]
        changed.append(('docs/DEVELOPING.md', f'{name} added, with no description'))
    if text != path.read_text():
        path.write_text(text)
    return changed
