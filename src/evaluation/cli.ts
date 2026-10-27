/**
 * cli.ts — operator tool for the replay simulator (runs with the server's service key; not an API).
 *
 *   npm run eval -- golden                                  # v1 rules vs the golden dataset
 *   npm run eval -- replay --org <uuid> [--since <ISO>] [--limit 200]
 *
 * Prints a one-line summary to stderr and the full JSON report to stdout.
 * Exit code 1 on bad arguments or a failed read; never writes anything.
 */
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { runGolden, replaySnapshots, v1Decider, QUALIFICATION_AGENT_NAME, ROUTING_AGENT_NAME, type Tally } from './replay.js'
import { listAgentProposals } from '../repositories/replay.repository.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const pct = (t: Tally | null) => (t && t.rate !== null ? `${t.agreed}/${t.total} (${Math.round(t.rate * 100)}%)` : 'n/a')

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { org: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string', default: '200' } },
  })
  const mode = positionals[0]

  if (mode === 'golden') {
    const report = await runGolden(v1Decider)
    const s = report.summary
    console.error(`golden ${report.datasetVersion} · ${report.decider.name} · qualification ${pct(s.qualification)} · routing ${pct(s.routing)} · injection ${pct(s.injection)}`)
    console.log(JSON.stringify(report, null, 2))
    return
  }

  if (mode === 'replay') {
    if (!values.org || !UUID.test(values.org)) throw new Error('--org <workspace uuid> is required')
    if (values.since && Number.isNaN(Date.parse(values.since))) throw new Error('--since must be an ISO date')
    const limit = Number(values.limit)
    const events = await listAgentProposals(values.org, [QUALIFICATION_AGENT_NAME, ROUTING_AGENT_NAME], { since: values.since, limit })
    const report = await replaySnapshots(v1Decider, events)
    const s = report.summary
    console.error(`replay ${events.length} events · ${report.decider.name} · qualification ${pct(s.qualification)} · routing ${pct(s.routing)} · skipped ${JSON.stringify(s.skipped)}`)
    console.log(JSON.stringify(report, null, 2))
    return
  }

  throw new Error('usage: eval golden | eval replay --org <uuid> [--since <ISO>] [--limit N]')
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
