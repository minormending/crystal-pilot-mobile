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
import subprocess
import sys

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


def words(n):
    """A number the way the running prose writes a big one.

    `word()` gives up above ninety-nine and hands back digits, which is right
    for a table cell and wrong in the middle of a sentence -- "the remaining
    188 were found" is not how the rest of that paragraph reads. The bare
    "hundred" with no "one" in front of it is the prose's own idiom, kept
    because the check exists to hold a sentence to a count and not to rewrite
    the sentence.
    """
    n = int(n)
    if n < 100:
        return word(n)
    hundreds, rest = divmod(n, 100)
    lead = 'hundred' if hundreds == 1 else f'{WORDS[hundreds]} hundred'
    return lead + (f' and {word(rest)}' if rest else '')


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
    """How many names travel in the digest a second device boots from.

    **The comments are stripped first, and that is not tidiness.** This
    counted every quoted run in the block, and the block is half prose: the
    apostrophe in "a badge-scaled wild level's base" opened a quote that
    closed on the next symbol's own, so one added name read as two. A count
    that goes up by two when one name is added is a count nobody can check
    the documentation against, which is the whole job of this file.
    """
    src = (ROOT / 'gen2' / 'symbols.js').read_text()
    block = src.split('export const SHARED_SYMBOLS = [')[1].split('];')[0]
    bare = '\n'.join(re.sub(r'//.*', '', line) for line in block.splitlines())
    return len(re.findall(r"'[^']+'", bare))


def doc_sections():
    """How many documentation sections opt into the drift check.

    **Asked of `docs-check` rather than counted here**, and the first draft
    did count here -- a regex over the markers, which came back 42 against
    that tool's 39. The three are the examples of the marker format inside
    fenced code blocks in the document that explains the marker format, and
    `docs-check` skips fences for exactly that reason. So a second scanner
    was already wrong three ways on its first run, in the same repository
    that has now twice written down what a second reader costs.
    """
    out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'docs-check')],
                         capture_output=True, text=True)
    m = re.search(r'(\d+) section\(s\) tracked', out.stdout)
    # -1 rather than a plausible fallback, and it earned that: the first draft
    # of `docs-check` printed its total only on the clean path, so asking this
    # mid-pass -- when sections had drifted, which is when a pass asks -- gave
    # nothing to match and `renumber` wrote the -1 straight into a diagram.
    # Which is the tool being honest, and is why the total now goes out on
    # every path over there instead of a guess going in here.
    return int(m.group(1)) if m else -1


def line_coverage():
    """The one headline percentage in the prose, asked of the tool that owns it.

    It had drifted eight points and in the wrong direction, which is the
    interesting part: the diagram said 65% from before [the honest
    denominator] and the tool says 57%. A number that is *too flattering* and
    unwatched is the worst of the three states a claim can be in -- nobody
    goes looking for it, and every argument built on it is weaker than it
    reads.
    """
    # `node`, not `sys.executable`: this one is JavaScript, because it reads
    # the same modules the app does. The first draft ran it under Python,
    # which failed silently into the -1 below -- and `renumber` wrote the -1
    # into the diagram, which is the tool doing exactly what it should with a
    # number that cannot be computed.
    out = subprocess.run(['node', str(ROOT / 'tools' / 'coverage')],
                         capture_output=True, text=True)
    m = re.search(r'run by the suite — (\d+)%', out.stdout)
    return int(m.group(1)) if m else -1


def sharp_groups():
    """How many check groups `check-checks` has a mutation for.

    The diagram in DEVELOPING.md draws this beside the group count, and the
    two are only equal while every group has one -- which is the claim the
    pairing is making. Counting them separately is what makes it a claim.
    """
    src = (ROOT / 'tools' / 'check-checks').read_text()
    # The keys of the mutation table, the way `check_groups` counts the keys of
    # CHECKS -- and not the `edit(` calls, which was the first draft and came
    # back one short: `gamefiles` mutates by *adding a tracked file* rather
    # than by editing one, so it is the one group whose mutation is not an
    # edit. A count of the wrong thing that is nearly right is the shape of
    # error this whole file exists to catch.
    block = src.split('    return {')[1].split('\n    }')[0]
    return len(re.findall(r'^\s*"[\w-]+":', block, re.M))


AUDIT_ROW = re.compile(r'^\| (\d+) \| .* \| .* \| .*\|$', re.M)
# The same row, with its columns kept apart, so the "Found by" column can be
# counted. One pattern would do for both and would have to be read twice to
# see which; two named patterns cost a line and read as what they are.
AUDIT_ROW_FULL = re.compile(r'^\| (\d+) \| (.*) \| (.*) \| (.*)\|$', re.M)


def audit_rows():
    """How many defects the audit table records."""
    return len(AUDIT_ROW.findall((ROOT / 'docs' / 'PROVEN.md').read_text()))


def audit_passes():
    """How many passes those defects came from."""
    rows = AUDIT_ROW.findall((ROOT / 'docs' / 'PROVEN.md').read_text())
    return len({int(n) for n in rows})


def audit_by_reading():
    """How many of those defects the "Found by" column credits to reading.

    Two numbers in the prose rest on this column and neither was watched: the
    method that found the most, and the tail that everything else found. Both
    are a count of a table three hundred rows below them, which is exactly the
    distance at which a number stops being re-checked -- and `word()` writes
    the tail in hundreds, so it drifts in words rather than digits and reads
    like prose either way.
    """
    text = (ROOT / 'docs' / 'PROVEN.md').read_text()
    return len([m for m in AUDIT_ROW_FULL.finditer(text)
                if m.group(4).strip() == 'reading'])


def audit_other_ways():
    """And the tail: every defect the other methods found."""
    return audit_rows() - audit_by_reading()


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
    # Ten more sentences about the same number, in three files, every one of
    # them typed by hand and every one of them stale: the digest has grown
    # fourteen names since somebody last counted, so each of these has been
    # quietly understating what leaves the device. Which is the one direction
    # a privacy claim must never be wrong in.
    ('gen2/symbols.js', r'(\d+) lines is about a kilobyte', shared_symbols),
    ('docs/DEVICES.md', r'the (\d+) addresses out of the symbol file',
     shared_symbols),
    ('docs/DEVICES.md', r'the app reads (\d+) symbols in it', shared_symbols),
    ('docs/DEVICES.md', r'the room carries those (\d+) addresses',
     shared_symbols),
    ('docs/DEVICES.md', r'\| (\d+) addresses out of it \|', shared_symbols),
    ('docs/DEVICES.md', r'A\["(\d+) addresses<br/>~1KB"\]', shared_symbols),
    ('docs/DEVICES.md', r'only the (\d+) it reads', shared_symbols),
    ('docs/CODE.md', r'the (\d+) addresses out of the symbol', shared_symbols),
    ('docs/CODE.md', r'looks up \*\*(\d+) symbols in it\*\*', shared_symbols),
    ('docs/CODE.md', r'carries those (\d+) lines', shared_symbols),
    ('docs/CODE.md', r'it reports (\d+) because that is how many symbols',
     shared_symbols),
    # `-?\d+` and not `\d+`, so `renumber` can heal a claim it has itself
    # written wrongly. It wrote `-1` into this very diagram when the counter
    # behind it could not answer, and then could not put it back -- a pattern
    # that only matches well-formed claims leaves a malformed one for a person
    # to find, which is the state a check gets edited around in.
    ('docs/DEVELOPING.md', r'docs-check<br/>(-?\d+) tracked sections',
     doc_sections),
    ('docs/DEVELOPING.md', r'"(\d+) of \d+ bite"', sharp_groups),
    ('docs/DEVELOPING.md', r'"(-?\d+)%, and where"', line_coverage),
    ('docs/DEVELOPING.md', r'"\d+ of (\d+) bite"', check_groups),
    ('docs/PROVEN.md', r'and found \*\*(\d+)\*\*', audit_rows),
    ('docs/PROVEN.md', r'\*\*([a-z-]+)\*\*\npasses went looking',
     lambda: word(audit_passes())),
    ('docs/PROVEN.md', r'\*\*Reading found ([a-z-]+)\*\*',
     lambda: word(audit_by_reading())),
    ('docs/PROVEN.md', r'the remaining ([a-z- ]+) were\nfound almost',
     lambda: words(audit_other_ways())),
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
