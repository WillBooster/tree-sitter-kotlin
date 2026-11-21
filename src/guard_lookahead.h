#ifndef TREE_SITTER_KOTLIN_GUARD_LOOKAHEAD_H_
#define TREE_SITTER_KOTLIN_GUARD_LOOKAHEAD_H_

typedef enum {
    GUARD_GROUP_UNKNOWN,
    GUARD_GROUP_CLOSED,
    GUARD_GROUP_UNTERMINATED,
    GUARD_GROUP_MISMATCHED,
    GUARD_GROUP_YIELDED,
    GUARD_GROUP_UNRESOLVED
} GuardGroupStatus;

typedef enum { GUARD_ALTERNATIVE_UNKNOWN, GUARD_ALTERNATIVE_ORDINARY, GUARD_ALTERNATIVE_SHARED } GuardAlternative;

// A replay word stores a Unicode codepoint and the advance in source bytes. A wide advance has a second
// word containing the next absolute offset. Captured parenthesis groups repurpose the codepoint as a group index.
#define GUARD_WORD_PAYLOAD 0x001fffffu
#define GUARD_WORD_HAS_GROUP 0x80000000u
#define GUARD_WORD_WIDTH_SHIFT 21
#define GUARD_CHECKPOINT_INTERVAL 32

typedef struct {
    uint32_t offset;
    size_t cursor;
} GuardCheckpoint;

typedef struct {
    GuardCheckpoint after;
    unsigned brace_depth;
    GuardGroupStatus status;
} GuardGroup;

typedef struct {
    uint32_t offset;
    bool retains_type_arrows;
} GuardProbePoint;

typedef struct {
    uint32_t *words;
    size_t word_capacity;
    GuardCheckpoint *checkpoints;
    size_t checkpoint_capacity;
    size_t checkpoint_count;
    GuardGroup *groups;
    size_t group_capacity;
    size_t group_count;
    uint32_t start;
    uint32_t end;
    GuardGroupStatus status;
    GuardProbePoint *pending_alternatives;
    size_t pending_capacity;
    uint8_t *alternatives;
    size_t alternatives_capacity;
} GuardCache;

typedef struct {
    TSLexer lexer;
    TSLexer *source;
    GuardCache *cache;
    uint32_t offset;
    size_t cursor;
    size_t pending_count;
    bool replay;
    bool used_terminal_group;
    bool recording;
} GuardLookahead;

static void guard_cache_free(GuardCache *cache) {
    ts_free(cache->words);
    ts_free(cache->checkpoints);
    ts_free(cache->groups);
    ts_free(cache->pending_alternatives);
    ts_free(cache->alternatives);
}

static bool guard_lookahead_eof(const TSLexer *lexer) {
    const GuardLookahead *input = (const GuardLookahead *)lexer;
    return input->replay ? input->offset >= input->cache->end : input->source->eof(input->source);
}

static uint32_t guard_source_offset(const TSLexer *source) {
    TSLexerPosition position;
    source->get_position(source, &position);
    return position.bytes;
}

static void *guard_reserve(void *items, size_t *capacity, size_t needed, size_t item_size) {
    if (needed <= *capacity) return items;
    size_t next = *capacity ? *capacity * 2 : 32;
    if (next < *capacity || next < needed || next > SIZE_MAX / item_size) return NULL;
    void *grown = ts_realloc(items, next * item_size);
    if (!grown) return NULL;
    *capacity = next;
    return grown;
}

static bool guard_record_checkpoint(GuardCache *cache, uint32_t offset, size_t cursor) {
    const size_t count = cache->checkpoint_count;
    if (count > 0 && cursor - cache->checkpoints[count - 1].cursor < GUARD_CHECKPOINT_INTERVAL) return true;
    GuardCheckpoint *points = guard_reserve(cache->checkpoints, &cache->checkpoint_capacity, count + 1, sizeof(*points));
    if (!points) return false;
    cache->checkpoints = points;
    cache->checkpoints[cache->checkpoint_count++] = (GuardCheckpoint){.offset = offset, .cursor = cursor};
    return true;
}

static void guard_cache_record(GuardLookahead *input, int32_t codepoint) {
    GuardCache *cache = input->cache;
    const uint32_t end = guard_source_offset(input->source);
    if (end == input->offset) return;
    const uint32_t distance = end - input->offset;
    const bool wide = distance > 4;
    const size_t needed = input->cursor + 1 + wide;
    uint32_t *words = guard_reserve(cache->words, &cache->word_capacity, needed, sizeof(*words));
    if (words) cache->words = words;
    if (end < input->offset || !words || !guard_record_checkpoint(cache, input->offset, input->cursor)) {
        input->recording = false;
        cache->end = cache->start;
        return;
    }
    const uint32_t width = wide ? 0 : distance;
    words[input->cursor++] = ((uint32_t)codepoint & GUARD_WORD_PAYLOAD) | (width << GUARD_WORD_WIDTH_SHIFT);
    if (wide) words[input->cursor++] = end;
    input->offset = end;
}

static void guard_step_cursor(const GuardCache *cache, uint32_t *offset, size_t *cursor) {
    const uint32_t word = cache->words[(*cursor)++];
    const uint32_t width = (word >> GUARD_WORD_WIDTH_SHIFT) & 7;
    if (width > 0) *offset += width;
    else *offset = cache->words[(*cursor)++];
}

static void guard_replay_at(GuardLookahead *input, uint32_t offset, size_t cursor) {
    input->offset = offset;
    input->cursor = cursor;
    if (offset >= input->cache->end) {
        input->lexer.lookahead = 0;
        return;
    }
    const uint32_t word = input->cache->words[cursor];
    const uint32_t payload = word & GUARD_WORD_PAYLOAD;
    if (word & GUARD_WORD_HAS_GROUP) input->lexer.lookahead = '(';
    else input->lexer.lookahead = payload == GUARD_WORD_PAYLOAD ? -1 : (int32_t)payload;
}

static void advance_guard_lookahead(TSLexer *lexer, bool skip) {
    GuardLookahead *input = (GuardLookahead *)lexer;
    if (input->replay) {
        if (!guard_lookahead_eof(lexer)) {
            uint32_t offset = input->offset;
            size_t cursor = input->cursor;
            guard_step_cursor(input->cache, &offset, &cursor);
            guard_replay_at(input, offset, cursor);
        }
        return;
    }
    const int32_t codepoint = lexer->lookahead;
    input->source->advance(input->source, skip);
    lexer->lookahead = input->source->lookahead;
    if (input->recording) guard_cache_record(input, codepoint);
}

static GuardCheckpoint guard_checkpoint_before(const GuardCache *cache, uint32_t target) {
    size_t left = 0;
    size_t right = cache->checkpoint_count;
    while (left + 1 < right) {
        const size_t middle = left + (right - left) / 2;
        if (cache->checkpoints[middle].offset <= target) left = middle;
        else right = middle;
    }
    return cache->checkpoints[left];
}

static void start_guard_replay(GuardLookahead *input, uint32_t target) {
    const GuardCache *cache = input->cache;
    if (target <= cache->start || target >= cache->end) return;
    GuardCheckpoint point = guard_checkpoint_before(cache, target);
    while (point.offset < target) guard_step_cursor(cache, &point.offset, &point.cursor);
    if (point.offset != target) return;
    input->replay = true;
    guard_replay_at(input, point.offset, point.cursor);
}

static GuardLookahead guard_lookahead(GuardCache *cache, TSLexer *source, bool allow_replay) {
    GuardLookahead input = {
        .lexer = {.lookahead = source->lookahead, .advance = advance_guard_lookahead, .eof = guard_lookahead_eof},
        .cache = cache, .source = source,
    };
    if (allow_replay && cache && cache->end > cache->start) start_guard_replay(&input, guard_source_offset(source));
    return input;
}

// Only starts strictly inside the snapshot can replay: its closing parenthesis bounds an inner probe, but the
// outer probe still needs the real source past that parenthesis to tell a conditional body from a guard.
static void guard_capture_start(GuardLookahead *input) {
    if (!input->cache || input->replay) return;
    input->offset = guard_source_offset(input->source);
    input->cursor = 0;
    input->cache->start = input->cache->end = input->offset;
    input->cache->checkpoint_count = input->cache->group_count = 0;
    input->recording = true;
}

static void guard_capture_end(GuardLookahead *input, GuardGroupStatus status) {
    if (!input->recording) return;
    if (status != GUARD_GROUP_UNRESOLVED) {
        input->cache->end = input->offset;
        input->cache->status = status;
    }
    input->recording = false;
}

static void guard_capture_group(GuardLookahead *input, size_t opener, unsigned brace_depth, GuardGroupStatus status) {
    if (!input->recording) return;
    GuardCache *cache = input->cache;
    const size_t index = cache->group_count;
    if (index > GUARD_WORD_PAYLOAD) return;
    GuardGroup *groups = guard_reserve(cache->groups, &cache->group_capacity, index + 1, sizeof(*groups));
    if (!groups) return;
    cache->groups = groups;
    cache->groups[cache->group_count++] = (GuardGroup){
        .after = {.offset = input->offset, .cursor = input->cursor},
        .brace_depth = brace_depth, .status = status,
    };
    cache->words[opener] = (cache->words[opener] & ~GUARD_WORD_PAYLOAD) | GUARD_WORD_HAS_GROUP | (uint32_t)index;
}

static GuardGroupStatus guard_replay_group(GuardLookahead *input, size_t opener, unsigned brace_depth) {
    if (!input->replay) return GUARD_GROUP_UNKNOWN;
    const uint32_t word = input->cache->words[opener];
    if (!(word & GUARD_WORD_HAS_GROUP)) return GUARD_GROUP_UNKNOWN;
    const GuardGroup *group = &input->cache->groups[word & GUARD_WORD_PAYLOAD];
    if (group->brace_depth != brace_depth) return GUARD_GROUP_UNKNOWN;
    guard_replay_at(input, group->after.offset, group->after.cursor);
    input->used_terminal_group = group->status != GUARD_GROUP_CLOSED;
    return group->status;
}

static bool guard_replay_needs_source(const GuardLookahead *input) {
    if (!input->replay || input->used_terminal_group || input->offset < input->cache->end) return false;
    const GuardGroupStatus status = input->cache->status;
    return status == GUARD_GROUP_MISMATCHED || status == GUARD_GROUP_YIELDED;
}

static GuardAlternative known_guard_alternative(const GuardLookahead *input) {
    const GuardCache *cache = input->cache;
    if (!cache || cache->alternatives_capacity == 0) return GUARD_ALTERNATIVE_UNKNOWN;
    const uint32_t offset = input->replay ? input->offset : guard_source_offset(input->source);
    if (offset / 4 >= cache->alternatives_capacity) return GUARD_ALTERNATIVE_UNKNOWN;
    return (GuardAlternative)((cache->alternatives[offset / 4] >> (2 * (offset % 4))) & 3);
}

static bool remember_guard_alternative(GuardLookahead *input) {
    GuardCache *cache = input->cache;
    if (!cache) return false;
    if (input->pending_count == cache->pending_capacity) {
        const size_t capacity = cache->pending_capacity ? cache->pending_capacity * 2 : 16;
        if (capacity <= cache->pending_capacity || capacity > SIZE_MAX / sizeof(GuardProbePoint)) return false;
        GuardProbePoint *positions = ts_realloc(cache->pending_alternatives, capacity * sizeof(GuardProbePoint));
        if (!positions) return false;
        cache->pending_alternatives = positions;
        cache->pending_capacity = capacity;
    }
    const uint32_t offset = input->replay || input->recording ? input->offset : guard_source_offset(input->source);
    cache->pending_alternatives[input->pending_count++] = (GuardProbePoint){.offset = offset};
    return true;
}

static void guard_alternative_retains_type_arrows(GuardLookahead *input) {
    input->cache->pending_alternatives[input->pending_count - 1].retains_type_arrows = true;
}

static void commit_guard_alternatives(GuardLookahead *input, bool saw_type_arrow, GuardAlternative outcome) {
    if (input->pending_count == 0) return;
    GuardCache *cache = input->cache;
    const size_t needed = cache->pending_alternatives[input->pending_count - 1].offset / 4 + 1;
    if (needed > cache->alternatives_capacity) {
        const size_t capacity = cache->alternatives_capacity * 2 > needed ? cache->alternatives_capacity * 2 : needed;
        uint8_t *bits = ts_realloc(cache->alternatives, capacity);
        if (!bits) return;
        memset(bits + cache->alternatives_capacity, 0, capacity - cache->alternatives_capacity);
        cache->alternatives = bits;
        cache->alternatives_capacity = capacity;
    }
    for (size_t index = 0; index < input->pending_count; index++) {
        const GuardProbePoint *point = &cache->pending_alternatives[index];
        if (saw_type_arrow && !point->retains_type_arrows) continue;
        const uint32_t offset = point->offset;
        const unsigned shift = 2 * (offset % 4);
        uint8_t *byte = &cache->alternatives[offset / 4];
        if (((*byte >> shift) & 3) == GUARD_ALTERNATIVE_UNKNOWN)
            *byte |= (uint8_t)((unsigned)outcome << shift);
    }
}

#endif
