import { Transcript } from '../src/main/transcript.ts'

let pass = 0, fail = 0
const ok = (cond: boolean, label: string) => {
  if (cond) { pass++ } else { fail++; console.log(`  FAIL: ${label}`) }
}

console.log('question detection:')
for (const q of [
  'So walk me through the hardest performance problem you have fixed recently.',
  'And what did you do about performance on that project?',
  'Okay, so tell me about your database experience.',
  'Um, right, how many rows was that migration.',
  'What is your notice period?',
  'Can you describe the rollback plan.'
]) ok(Transcript.isQuestion(q), `should be question: "${q}"`)

for (const s of [
  'That sounds really impressive.',
  'We migrated ours last year too.',
  'Okay.',
  'Yeah exactly.'
]) ok(!Transcript.isQuestion(s), `should NOT be question: "${s}"`)

console.log('echo retraction (echo arrives BEFORE the original):')
{
  const t = new Transcript()
  t.ingest('me', 'So walk me through the hardest performance problem', true)
  t.ingest('them', 'So walk me through the hardest performance problem', true)
  const seen = t.drain()
  ok(!seen.includes('ME:'), 'mic echo should be retracted from model input')
  ok(seen.includes('THEM:'), 'their turn should survive')
}

console.log('echo suppression (echo arrives AFTER the original):')
{
  const t = new Transcript()
  t.ingest('them', 'What was the biggest migration you have done', true)
  const echo = t.ingest('me', 'What was the biggest migration you have done', true)
  ok(echo === null, 'mic echo should be dropped outright')
}

console.log('genuine speech is kept:')
{
  const t = new Transcript()
  t.ingest('them', 'What was the biggest migration you have done', true)
  t.ingest('me', 'Forty million rows off MySQL onto Postgres last quarter', true)
  const seen = t.drain()
  ok(seen.includes('ME: Forty million'), 'real answer must not be treated as echo')
}

console.log('short acknowledgements survive:')
{
  const t = new Transcript()
  t.ingest('them', 'Okay so that is really interesting', true)
  ok(t.ingest('me', 'Okay', true) !== null, '"Okay" must not be swallowed as echo')
}

console.log('urdu questions:')
for (const q of [
  'Aap ka experience kitna hai',
  'Apne last project ke baare mein batao',
  'आपने पिछली कंपनी क्यों छोड़ी',
  'آپ کا تجربہ کتنا ہے',
  'Postgres mein indexing kaise karte hain'
]) ok(Transcript.isQuestion(q), `should be question: "${q}"`)
for (const s of ['Theek hai, samajh gaya', 'अच्छा, बहुत बढ़िया है'])
  ok(!Transcript.isQuestion(s), `should NOT be question: "${s}"`)

console.log('urdu echo is caught:')
{
  const t = new Transcript()
  t.ingest('them', 'आपने पिछली कंपनी में क्या काम किया था', true)
  ok(t.ingest('me', 'आपने पिछली कंपनी में क्या काम किया था', true) === null, 'Devanagari echo must be dropped')
  t.ingest('them', 'آپ نے پچھلی کمپنی میں کیا کام کیا', true)
  ok(t.ingest('me', 'آپ نے پچھلی کمپنی میں کیا کام کیا', true) === null, 'Urdu-script echo must be dropped')
  t.ingest('me', 'मैंने वहाँ payments का backend बनाया था', true)
  ok(t.drain().includes('ME: मैंने'), 'genuine Hindi-script answer must survive')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
