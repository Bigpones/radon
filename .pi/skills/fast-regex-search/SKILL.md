---
name: fast-regex-search
description: Trigram-indexed regex search for large codebases. Loads automatically on startup to accelerate all grep/search operations. Implements sparse n-gram indexing with frequency-weighted trigram decomposition, bloom-filter adjacency masks, and mmap'd posting lists for sub-50ms regex matching across 500k+ files.
---

# Fast Regex Search — Indexed Text Search for Agent Tools

## Purpose

Replace brute-force `ripgrep` scans with an indexed search pipeline when working in large codebases. This algorithm pre-indexes source files using sparse n-grams so that regex queries hit a posting-list lookup (O(log n) binary search) instead of scanning every file (O(n) linear).

**When to use:** Any codebase where `rg` takes >2s. Particularly monorepos, vendor-heavy projects, or codebases with >10k files.

**When NOT to use:** Small projects (<1k files) where `rg` completes in <500ms. The overhead of index construction isn't worth it.

## Algorithm Overview

The search pipeline has three phases: **Index**, **Query**, **Verify**.

### Phase 1: Index (build time)

Build a sparse n-gram inverted index over all source files.

#### 1A. Sparse N-gram Extraction (`build_all` mode)

For each file, extract variable-length n-grams using a deterministic weight function:

```
weight(char_pair) = frequency_rank(char_pair)
```

Where `frequency_rank` is derived from a character-pair frequency table built from a large corpus of open-source code. Rare pairs get HIGH weight; common pairs get LOW weight.

**N-gram boundary rule:** An n-gram is any substring where the weights at both endpoints are strictly greater than all weights contained inside.

```python
def build_all_sparse_ngrams(text: str, weight_fn) -> list[tuple[str, int]]:
    """Extract ALL sparse n-grams from text for indexing.

    Returns list of (ngram, position) tuples.
    """
    ngrams = []
    n = len(text)
    if n < 2:
        return ngrams

    # Compute weights for every adjacent character pair
    weights = [weight_fn(text[i], text[i+1]) for i in range(n - 1)]

    # Stack-based extraction: find all substrings where
    # edge weights > all interior weights
    for start in range(n - 1):
        # Walk right from start, extending while interior weights are lower
        max_interior = -1
        for end in range(start + 1, min(start + MAX_NGRAM_LEN, n)):
            if end < n - 1:
                # Check if this could be an endpoint
                if weights[end] > max_interior and weights[end] >= weights[start]:
                    ngrams.append((text[start:end+2], start))
            if end > start:
                max_interior = max(max_interior, weights[end - 1] if end - 1 > start else -1)

    return ngrams
```

#### 1B. Inverted Index Construction

```
For each file F in codebase:
    For each (ngram, position) in build_all_sparse_ngrams(F.content):
        hash = fnv1a_64(ngram)
        postings[hash].append(FilePosting(
            file_id = F.id,
            loc_mask = 1 << (position % 8),      # 8-bit position bloom
            next_mask = char_hash(F.content[position + len(ngram)]) if exists  # 8-bit follow-char bloom
        ))
```

#### 1C. Disk Layout (two files)

| File | Contents | Access Pattern |
|------|----------|----------------|
| `index.postings` | Posting lists, concatenated, flushed sequentially | Random read at offset |
| `index.lookup` | Sorted `(hash, offset)` pairs | `mmap`'d, binary search |

**Why two files:** Only the lookup table is mmap'd into the editor process. Posting lists are read on-demand from disk at the offset found in the lookup table. This keeps resident memory minimal (~2-4 bytes per unique n-gram).

### Phase 2: Query (search time)

#### 2A. Sparse N-gram Covering (`build_covering` mode)

At query time, extract only the MINIMUM set of n-grams needed to cover the search pattern. Because the weight function is deterministic, the covering set is guaranteed to be a subset of what was indexed.

```python
def build_covering_ngrams(pattern: str, weight_fn) -> list[str]:
    """Extract MINIMAL covering n-grams for a query pattern.

    Uses the same weight function as indexing, but only generates
    n-grams at boundary positions — far fewer than build_all.
    """
    ngrams = []
    n = len(pattern)
    if n < 2:
        return ngrams

    weights = [weight_fn(pattern[i], pattern[i+1]) for i in range(n - 1)]

    i = 0
    while i < n - 1:
        # Find the local maximum weight starting from position i
        best_end = i
        for j in range(i + 1, min(i + MAX_NGRAM_LEN, n - 1)):
            if weights[j] >= weights[best_end]:
                best_end = j

        # Extract n-gram from i to best_end + 2
        ngram = pattern[i:best_end + 2]
        if len(ngram) >= 2:
            ngrams.append(ngram)

        # Advance past the covered region
        i = best_end + 1

    return ngrams
```

#### 2B. Regex Decomposition

For regex patterns (not just literals), decompose into extractable literal segments:

```
Pattern: /MAX_FILE_SIZE/     → literals: ["MAX_FILE_SIZE"]
Pattern: /foo(bar|baz)/      → literals: ["foo"] + OR(["bar"], ["baz"])
Pattern: /test_\w+\.py/      → literals: ["test_"], [".py"]
Pattern: /[rbc]at/           → OR(["rat"], ["bat"], ["cat"])
Pattern: /\d{3}-\d{4}/      → literals: ["-"]   (character classes break n-gram extraction)
```

**Rule:** Extract n-grams only from literal segments. Character classes (`.`, `\w`, `\d`, `[...]`) break n-gram boundaries. Alternations (`|`) create OR branches where ANY branch matching is sufficient.

#### 2C. Posting List Lookup

```
For each covering n-gram:
    hash = fnv1a_64(ngram)
    offset = binary_search(mmap'd lookup_table, hash)
    posting_list = read_at_offset(postings_file, offset)

candidate_files = intersect(all posting_lists)  # AND for sequential n-grams
                                                 # OR for alternation branches
```

#### 2D. Adjacency Filtering (Bloom Masks)

For consecutive n-grams in the query, apply two additional filters before accepting a candidate:

```
1. nextMask filter: Does the first n-gram's follow-char bloom contain
   the first char of the second n-gram?
   → nextMask(ngram1, file) & char_hash(ngram2[0]) != 0

2. locMask filter: Are the two n-grams actually adjacent in the file?
   → (locMask(ngram1, file) << 1) & locMask(ngram2, file) != 0
```

Both filters are probabilistic (bloom filters can false-positive) but never false-negative. They dramatically reduce candidate sets for common trigrams.

### Phase 3: Verify (match time)

```
For each candidate_file in candidate_files:
    content = read_file(candidate_file)
    matches = regex_match(pattern, content)  # standard ripgrep/RE2 matching
    yield matches
```

**This is always required.** The index only narrows candidates — final matching must be exact.

## Weight Function: Character-Pair Frequency Table

The weight function is the critical optimization. Use inverse frequency from a large code corpus:

```python
# Pre-computed from ~2TB of open-source code
# Higher weight = rarer pair = better n-gram boundary
PAIR_FREQUENCY = {
    ('e', ' '): 1,    # very common → low weight
    (' ', 't'): 2,    # very common → low weight
    ('t', 'h'): 3,    # common → low weight
    ...
    ('X', '_'): 847,   # rare → high weight
    ('Q', 'z'): 9241,  # very rare → high weight
}

def weight_fn(c1: str, c2: str) -> int:
    return PAIR_FREQUENCY.get((c1, c2), len(PAIR_FREQUENCY) // 2)
```

**Why frequency-based weighting wins:** Rare character pairs become n-gram boundaries, which means the extracted n-grams contain the MOST SPECIFIC substrings. At query time, the covering algorithm produces fewer, longer, more discriminating n-grams — resulting in smaller posting lists and fewer candidates to verify.

**Fallback:** If no frequency table is available, use `crc32(c1 + c2)` as a deterministic pseudo-random weight. This still works but produces ~30% more candidates than frequency-based weighting.

## Index Lifecycle

### Construction Triggers
- First open of a workspace with >5k files
- Background rebuild after `git pull` / `git checkout` that changes >100 files

### Incremental Updates
- Base index is keyed to a git commit SHA
- Uncommitted changes (dirty files) are stored as a **delta layer** on top
- Agent writes are immediately reflected in the delta layer (read-your-own-writes)
- On commit, delta merges into base; on checkout, base rebuilds

### Staleness Contract
- Index MUST reflect the current working tree within 1s of any file write
- Stale index results in agents chasing phantom code — worse than no index at all

## Performance Characteristics

| Metric | Brute-force (rg) | Indexed Search |
|--------|-------------------|----------------|
| Cold query, 10k files | 800ms | 50ms |
| Cold query, 100k files | 8s | 80ms |
| Cold query, 500k files | 15s+ | 120ms |
| Index build, 100k files | — | 30s (one-time) |
| Index size (100k files) | — | ~200MB (lookup + postings) |
| Memory (mmap'd lookup) | — | ~40MB resident |
| Incremental update | — | <100ms per file |

## Integration with Agent Search Tools

When this index is available, the search tool pipeline becomes:

```
Agent calls grep("pattern", path) →
  1. Decompose pattern into covering n-grams
  2. Query index for candidate files
  3. Run ripgrep ONLY on candidate files (not full codebase)
  4. Return matches
```

This is transparent to the agent — it still calls `grep` the same way. The index acts as a pre-filter that reduces the search space by 90-99%.

## Implementation Notes

- **Hash function:** FNV-1a 64-bit for n-gram hashing. Fast, well-distributed, no crypto overhead.
- **Posting list compression:** Delta-encoded file IDs + varint encoding. Typical compression ratio: 3-5x.
- **Max n-gram length:** Cap at 8 characters. Longer n-grams have diminishing returns and bloat the index.
- **Minimum n-gram length:** 2 characters (bigrams as floor). Single characters are too broad.
- **Bloom filter size:** 8 bits for both `locMask` and `nextMask`. Saturation becomes a problem above ~40 entries per posting; at that point, the bloom filter matches everything and provides no filtering benefit.

## References

- Zobel, Moffat, Sacks-Davis (1993): "Searching Large Lexicons for Partially Specified Terms using Compressed Inverted Files"
- Russ Cox (2012): "Regular Expression Matching with a Trigram Index" (Google Code Search)
- Nelson Elhage (2015): "Regular Expression Search with Suffix Arrays" (livegrep)
- GitHub Project Blackbird: Trigram + probabilistic bloom masks
- GitHub Code Search / ClickHouse: Sparse n-gram indexing with frequency-weighted boundaries
- Cursor (2026): "Fast regex search: indexing text for agent tools" — local index with mmap'd lookup tables
