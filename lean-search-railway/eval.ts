// Quality eval for the deployed lean-search service: a golden set of classic
// results across math areas, each with accept-patterns for the Mathlib names
// that answer it. Scores hit@1 / hit@3 / hit@10 and prints misses in full.
//
//   RAILWAY_LEAN_SEARCH_URL=… RAILWAY_LEAN_SEARCH_API_KEY=… node dist/eval.js [--no-augment]
const URL = (process.env.RAILWAY_LEAN_SEARCH_URL || "").replace(/\/$/, "");
const KEY = process.env.RAILWAY_LEAN_SEARCH_API_KEY || "";
const AUGMENT = !process.argv.includes("--no-augment");
if (!URL || !KEY) throw new Error("set RAILWAY_LEAN_SEARCH_URL / RAILWAY_LEAN_SEARCH_API_KEY");

// [query, accept regexes (any match on declaration name counts as a hit)]
const GOLDEN: [string, RegExp[]][] = [
  ["the order of a subgroup divides the order of the group", [/card_subgroup_dvd_card/, /card_dvd_of_le/, /index_mul_card/]],
  ["there are infinitely many prime numbers", [/exists_infinite_primes/, /infinite.*[Pp]rime/, /[Pp]rime.*[Ii]nfinite/]],
  ["Fermat's little theorem", [/pow_card_sub_one_eq_one/, /pow_card/, /[Ff]ermat/]],
  ["binomial theorem expanding a power of a sum", [/add_pow/, /binomial/i]],
  ["Cauchy-Schwarz inequality for inner product spaces", [/inner_mul_le_norm_mul_norm/, /abs_inner_le_norm/]],
  ["squeeze theorem: a sequence between two sequences with the same limit converges", [/tendsto_of_tendsto_of_tendsto_of_le_of_le/, /squeeze/i]],
  ["every bounded sequence of real numbers has a convergent subsequence", [/tendsto_subseq/, /subseq/]],
  ["pigeonhole principle: mapping a larger finite set into a smaller one collides", [/exists_ne_map_eq/, /pigeonhole/i]],
  ["Zorn's lemma: a partial order with upper bounds for chains has a maximal element", [/zorn/i]],
  ["intermediate value theorem for continuous functions", [/intermediate_value/]],
  ["mean value theorem: derivative equals the slope of the secant somewhere", [/exists_hasDerivAt_eq_slope/, /exists_deriv_eq_slope/]],
  ["fundamental theorem of calculus relating integral and derivative", [/integral_deriv_eq_sub/, /integral_eq_sub_of_hasDerivAt/, /deriv_integral/]],
  ["fundamental theorem of algebra: every nonconstant complex polynomial has a root", [/exists_root/, /isAlgClosed/i]],
  ["gcd of two integers is an integer linear combination of them", [/gcd_eq_gcd_ab/, /bezout/i]],
  ["the derivative of the sine function is cosine", [/deriv_sin/]],
  ["a continuous real function on a compact set attains its maximum", [/exists_isMaxOn/, /exists_forall_ge/, /exists_max/]],
  ["the composition of two continuous functions is continuous", [/Continuous\.comp/, /continuous_comp/i]],
  ["Cantor's theorem: no surjection from a set onto its power set", [/cantor/i]],
  ["Banach fixed point theorem for contraction mappings", [/fixedPoint/i, /ContractingWith/]],
  ["Sylow's theorem: existence of a subgroup of prime power order", [/[Ss]ylow/, /exists_subgroup_card_pow_prime/]],
  ["law of quadratic reciprocity", [/quadratic_reciprocity/]],
  ["triangle inequality for norms", [/norm_add_le/, /dist_triangle/]],
  ["the sum of the first n natural numbers equals n(n+1)/2", [/sum_range_id/, /[Gg]auss_sum/]],
  ["the rational numbers are countable", [/[Cc]ountable/, /[Dd]enumerable/]],
  ["L'Hopital's rule for limits of quotients", [/lhopital/i]],
  ["a subset of Euclidean space is compact iff it is closed and bounded", [/isCompact_iff_isClosed_bounded/, /[Hh]eine/]],
];

interface Result { name: string }

async function search(query: string): Promise<{ results: Result[]; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query, k: 10, augment: AUGMENT }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as { results?: Result[] };
  return { results: out.results || [], ms: Date.now() - t0 };
}

// All queries in parallel - the service fans out to Gemini fine.
const settled = await Promise.all(
  GOLDEN.map(async ([q, pats]) => {
    const { results, ms } = await search(q);
    const rank = results.findIndex((r) => pats.some((p) => p.test(r.name)));
    return { q, rank, ms, top: results.slice(0, 3).map((r) => r.name) };
  })
);

let hit1 = 0, hit3 = 0, hit10 = 0;
const misses: { q: string; rank: number; top: string[] }[] = [];
const lat: number[] = [];
for (const { q, rank, ms, top } of settled) {
  lat.push(ms);
  if (rank === 0) hit1++;
  if (rank >= 0 && rank < 3) hit3++;
  if (rank >= 0) hit10++;
  const mark = rank === 0 ? "1st" : rank > 0 ? `#${rank + 1}` : "MISS";
  console.log(`${mark.padEnd(5)} ${ms}ms  ${q}`);
  if (rank !== 0) misses.push({ q, rank, top });
}

const n = GOLDEN.length;
lat.sort((a, b) => a - b);
console.log(`\n=== augment=${AUGMENT} ===`);
console.log(`hit@1  ${hit1}/${n}   hit@3  ${hit3}/${n}   hit@10 ${hit10}/${n}`);
console.log(`latency p50 ${lat[Math.floor(n / 2)]}ms  max ${lat[n - 1]}ms`);
if (misses.length) {
  console.log(`\n--- not ranked #1 ---`);
  for (const m of misses) console.log(`  [${m.rank < 0 ? "MISS" : "#" + (m.rank + 1)}] ${m.q}\n        top3: ${m.top.join(", ")}`);
}
