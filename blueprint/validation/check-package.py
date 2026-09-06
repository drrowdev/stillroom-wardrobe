"""Static blueprint consistency checks, not application acceptance tests.
Run with Python 3 from any working directory. Emits machine-readable results.
"""
from pathlib import Path
import json
import re

p = Path(__file__).resolve().parents[1]
expected = ['00-INDEX.md', '01-RESEARCH.md', '02-PRODUCT-REQUIREMENTS.md',
 '03-MVP-AND-NON-GOALS.md', '04-USER-FLOWS-AND-SCREENS.md', '05-ARCHITECTURE.md',
 '06-DATA-MODEL.md', '07-DATABASE-AND-RLS.sql', '08-API-AND-STORAGE.md',
 '09-RECOMMENDATIONS.md', '10-SECURITY-AND-PRIVACY.md', '11-COST-AND-HOSTING.md',
 '12-TEST-STRATEGY.md', '13-REPOSITORY-STRUCTURE.md', '14-IMPLEMENTATION-PLAN.md',
 '15-GITHUB-ISSUES.md', '16-COPILOT-PROMPTS.md', '17-DEPLOYMENT-AND-RECOVERY.md',
 '18-DECISIONS-ASSUMPTIONS-QUESTIONS.md', '19-LOCALIZATION.md',
 '20-AI-MODELS-AND-WORKFLOWS.md', '21-AI-MODEL-COMPARISON.md',
 'AGENTS.md', '.github/copilot-instructions.md']
checks = []
def passed(name):
    checks.append({'name': name, 'result': 'PASS'})

assert all((p/name).is_file() and (p/name).stat().st_size > 0 for name in expected)
passed('All required blueprint files exist, including localization, AI contracts and agent templates')
for f in p.rglob('*.md'):
    text = f.read_text()
    assert len(re.findall(r'^```', text, re.M)) % 2 == 0, f'Unbalanced code fence: {f}'
    for reference in set(re.findall(r'(?<![\w/])(?:\d{2}-[A-Z-]+\.md|07-DATABASE-AND-RLS\.sql)', text)):
        assert (p/reference).is_file(), f'Missing blueprint reference {reference} in {f.name}'
passed('Markdown fences and named blueprint file references are valid')

issues_text = (p/'15-GITHUB-ISSUES.md').read_text()
parts = re.split(r'^## (I\d{2}) — ', issues_text, flags=re.M)
issues = dict(zip(parts[1::2], parts[2::2]))
expected_order = [f'I{i:02}' for i in range(1, 8)] + ['I29'] + [f'I{i:02}' for i in range(8, 29)]
assert list(issues) == expected_order
positions = {key: index for index, key in enumerate(issues)}
for key, body in issues.items():
    for field in ['Goal:', 'Depends on:', 'Target files:', 'Test files:', 'Acceptance:', 'Security:', 'Done:']:
        assert field in body, (key, field)
    deps = re.search(r'Depends on: \*\*(.*?)\*\*', body).group(1)
    assert all(dep in positions and positions[dep] < positions[key]
               for dep in re.findall(r'I\d{2}', deps)), key
    phase = int(re.search(r'Phase: \*\*(\d+)\*\*', body).group(1))
    assert (phase == 8) == (key in {'I27', 'I28'}), key
    if key == 'I29':
        assert phase == 2
passed('29 issue packets have complete fields, acyclic dependencies and an explicit optional Phase 8 boundary')

trace_document = json.loads((p/'validation/traceability.json').read_text())
trace = trace_document['requirements']
assert trace_document['issue_ids'] == expected_order
assert [row['id'] for row in trace] == [f'R{i:02}' for i in range(1, 29)]
requirements = (p/'02-PRODUCT-REQUIREMENTS.md').read_text()
for row in trace:
    assert f"| {row['id']} |" in requirements, row['id']
    linked = re.findall(r'I\d{2}', row['issues'])
    assert linked and all(i in issues for i in linked), row['id']
    assert all(row.get(k) for k in ['screen', 'data', 'operation', 'test']), row['id']
    assert any(row['test'] in issues[i] for i in linked), f"Unassigned test for {row['id']}: {row['test']}"
passed('All 28 requirements map through screens/data/operations to an issue and an assigned test path')

prompts = (p/'16-COPILOT-PROMPTS.md').read_text()
first = re.search(r'```text\n([\s\S]*?)```', prompts).group(1).strip()
assert first == (p/'FIRST-COPILOT-PROMPT.txt').read_text().strip()
assert set(re.findall(r'^## Phase (\d+)', prompts, re.M)) == set(map(str, range(9)))
passed('The standalone first prompt is exact; all nine phases have a prompt')
research = (p/'01-RESEARCH.md').read_text()
ledger = re.findall(r'^\| S\d{2} \| .*?\]\((https://[^)]+)\)', research, re.M)
assert len(ledger) == len(set(ledger)) == 12
assert '2026-09-05' in research
passed('Original research ledger retains its 12 unique public sources and access date')

ai = (p/'20-AI-MODELS-AND-WORKFLOWS.md').read_text()
assert 'gemini-3.5-flash-lite' in ai and 'gpt-5.6-terra' in ai
assert '2026-09-06' in ai and 'Outfits remain deterministic' in ai
assert 'I29' in issues_text and 'R28' in requirements
assert 'I07, I29, I08, I09, I10' in prompts
assert 'metadata schema v2' in (p/'19-LOCALIZATION.md').read_text()
passed('AI model contract, approved deterministic outfits, phase order and recovery revision are documented')

comparison = (p/'21-AI-MODEL-COMPARISON.md').read_text()
for model in ['gemini-3.5-flash-lite', 'gpt-5.4-mini-2026-03-17', 'gpt-5.6-luna',
              'mistral-small-2603', 'claude-sonnet-5', 'gemini-3.8-flash']:
    assert model in comparison, model
assert 'not the cheapest current model' in comparison
for name in ['00-INDEX.md', '05-ARCHITECTURE.md', '17-DEPLOYMENT-AND-RECOVERY.md',
             '18-DECISIONS-ASSUMPTIONS-QUESTIONS.md', 'FIRST-COPILOT-PROMPT.txt']:
    text = (p/name).read_text()
    assert 'Stockholm' in text and 'eu-north-1' in text, name
    assert 'default Frankfurt' not in text, name
passed('Stockholm project region and the expanded dated model comparison are wired into the plan')

assert 'photo upload -> automatically filled editable form -> explicit Save to library' in ai
assert 'No name or category is required to start' in ai
assert 'private.ai_requests' in ai and 'analyze-clothing' in ai
assert 'alt_text' in ai and 'Save does not convert estimates into confirmed physical facts' in ai
assert 'No library item/image exists before Save or after discard' in issues['I29']
assert trace[-1]['operation'] == 'Analyze draft; edit all fields; explicit Save/discard'
active_contracts = [
    p/'02-PRODUCT-REQUIREMENTS.md', p/'04-USER-FLOWS-AND-SCREENS.md',
    p/'08-API-AND-STORAGE.md', p/'12-TEST-STRATEGY.md',
    p/'13-REPOSITORY-STRUCTURE.md', p/'15-GITHUB-ISSUES.md',
    p/'16-COPILOT-PROMPTS.md', p/'AGENTS.md',
]
for contract in active_contracts:
    text = contract.read_text()
    assert 'tag-clothing/index.ts' not in text, contract
    assert 'private.ai_jobs' not in text, contract
    assert 'details save automatically without per-photo approval' not in text, contract
passed('Photo-first draft, editable pre-save fields and no post-save worker are consistent')

for file in [p/'07-DATABASE-AND-RLS.sql', p/'FIRST-COPILOT-PROMPT.txt', p/'AGENTS.md', p/'.github/copilot-instructions.md', *p.rglob('*.mjs')]:
    assert 'acloset' not in file.read_text().lower(), file
passed('Product/SQL/agent templates and reference code contain no reference-product brand')

def luminance(colour):
    rgb = [int(colour[i:i+2], 16)/255 for i in (1, 3, 5)]
    linear = [v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    return sum(v*w for v, w in zip(linear, [.2126, .7152, .0722]))

contrast = []
for fg, bg, minimum in [('#24332E', '#F6F3ED', 4.5), ('#59665F', '#F6F3ED', 4.5),
                       ('#24332E', '#FFFFFF', 4.5), ('#59665F', '#FFFFFF', 4.5),
                       ('#FFFFFF', '#355D4E', 4.5), ('#FFFFFF', '#294B3E', 4.5),
                       ('#FFFFFF', '#A45E45', 4.5), ('#A33232', '#F6F3ED', 4.5),
                       ('#176B73', '#F6F3ED', 3), ('#176B73', '#FFFFFF', 3),
                       ('#78877D', '#F6F3ED', 3), ('#78877D', '#FFFFFF', 3)]:
    low, high = sorted([luminance(fg), luminance(bg)])
    ratio = (high+.05)/(low+.05)
    assert ratio >= minimum, (fg, bg, ratio)
    contrast.append({'foreground': fg, 'background': bg, 'ratio': round(ratio, 2), 'minimum': minimum})
passed('Twelve specified text/action/focus/input colour pairings meet their contrast thresholds')

architecture = (p/'05-ARCHITECTURE.md').read_text()
scores = [tuple(map(int, m)) for m in re.findall(r'^\| [^|\n]+ \| (\d) \| (\d) \| (\d) \|$', architecture, re.M)]
assert len(scores) == 12 and [sum(row[i] for row in scores) for i in range(3)] == [51, 42, 44]
passed('The 12-factor platform comparison totals are correct')
print(json.dumps({'scope': 'Static package consistency only', 'checks': checks, 'contrast': contrast}, indent=2))
