#ifndef TREE_SITTER_KOTLIN_GUARD_LOOKAHEAD_H_
#define TREE_SITTER_KOTLIN_GUARD_LOOKAHEAD_H_

typedef enum {
    GUARD_GROUP_UNKNOWN,
    GUARD_GROUP_CLOSED,
    GUARD_GROUP_UNTERMINATED,
    GUARD_GROUP_MISMATCHED,
    GUARD_GROUP_UNRESOLVED
} GuardGroupStatus;

typedef struct {
    int32_t codepoint;
    uint32_t after_group;
    unsigned brace_depth;
    uint8_t width;
    uint8_t group_status;
} GuardCharacter;

typedef struct {
    uint32_t offset;
    bool retains_type_arrows;
} GuardProbePoint;

typedef struct {
    GuardCharacter *characters;
    size_t capacity;
    uint32_t start;
    uint32_t end;
    GuardProbePoint *pending_alternatives;
    size_t pending_capacity;
    uint8_t *ordinary_alternatives;
    size_t ordinary_capacity;
} GuardCache;

typedef struct {
    TSLexer lexer;
    TSLexer *source;
    GuardCache *cache;
    uint32_t offset;
    size_t pending_count;
    bool replay;
    bool recording;
} GuardLookahead;

static void guard_cache_free(GuardCache *cache) {
    ts_free(cache->characters);
    ts_free(cache->pending_alternatives);
    ts_free(cache->ordinary_alternatives);
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

static bool guard_cache_reserve(GuardCache *cache, size_t needed) {
    if (needed <= cache->capacity) return true;
    const size_t capacity = cache->capacity ? cache->capacity * 2 : 128;
    if (capacity < needed || capacity > SIZE_MAX / sizeof(GuardCharacter)) return false;
    GuardCharacter *characters = ts_realloc(cache->characters, capacity * sizeof(GuardCharacter));
    if (!characters) return false;
    cache->characters = characters;
    cache->capacity = capacity;
    return true;
}

static void guard_cache_record(GuardLookahead *input, int32_t codepoint) {
    GuardCache *cache = input->cache;
    const uint32_t end = guard_source_offset(input->source);
    if (end == input->offset) return;
    const uint32_t width = end - input->offset;
    if (width > 4 || !guard_cache_reserve(cache, end - cache->start)) {
        input->recording = false;
        cache->end = cache->start;
        return;
    }
    GuardCharacter *characters = cache->characters + (input->offset - cache->start);
    characters[0] = (GuardCharacter){.codepoint = codepoint, .width = (uint8_t)width};
    for (uint32_t index = 1; index < width; index++) characters[index].width = 0;
    input->offset = end;
}

static void guard_replay_at(GuardLookahead *input, uint32_t offset) {
    const GuardCache *cache = input->cache;
    input->offset = offset;
    input->lexer.lookahead = offset < cache->end ? cache->characters[offset - cache->start].codepoint : 0;
}

static void advance_guard_lookahead(TSLexer *lexer, bool skip) {
    GuardLookahead *input = (GuardLookahead *)lexer;
    if (input->replay) {
        if (!guard_lookahead_eof(lexer)) {
            const GuardCache *cache = input->cache;
            guard_replay_at(input, input->offset + cache->characters[input->offset - cache->start].width);
        }
        return;
    }
    const int32_t codepoint = lexer->lookahead;
    input->source->advance(input->source, skip);
    lexer->lookahead = input->source->lookahead;
    if (input->recording) guard_cache_record(input, codepoint);
}

static GuardLookahead guard_lookahead(GuardCache *cache, TSLexer *source) {
    GuardLookahead input = {
        .lexer = {.lookahead = source->lookahead, .advance = advance_guard_lookahead, .eof = guard_lookahead_eof},
        .cache = cache, .source = source,
    };
    if (cache && cache->end > cache->start) {
        const uint32_t offset = guard_source_offset(source);
        if (offset > cache->start && offset < cache->end && cache->characters[offset - cache->start].width != 0) {
            input.offset = offset;
            input.replay = true;
        }
    }
    return input;
}

// Only starts strictly inside the snapshot can replay: its closing parenthesis bounds an inner probe, but the
// outer probe still needs the real source past that parenthesis to tell a conditional body from a guard.
static void guard_capture_start(GuardLookahead *input) {
    if (!input->cache || input->replay) return;
    input->offset = guard_source_offset(input->source);
    input->cache->start = input->cache->end = input->offset;
    input->recording = true;
}

static void guard_capture_end(GuardLookahead *input, GuardGroupStatus status) {
    if (!input->recording) return;
    if (status != GUARD_GROUP_UNRESOLVED) input->cache->end = input->offset;
    input->recording = false;
}

static void guard_capture_group(GuardLookahead *input, uint32_t start, unsigned brace_depth, GuardGroupStatus status) {
    if (!input->recording) return;
    GuardCharacter *character = &input->cache->characters[start - input->cache->start];
    character->after_group = input->offset;
    character->brace_depth = brace_depth;
    character->group_status = (uint8_t)status;
}

static GuardGroupStatus guard_replay_group(GuardLookahead *input, uint32_t start, unsigned brace_depth) {
    if (!input->replay) return GUARD_GROUP_UNKNOWN;
    const GuardCharacter *character = &input->cache->characters[start - input->cache->start];
    if (character->after_group == 0 || character->brace_depth != brace_depth) return GUARD_GROUP_UNKNOWN;
    guard_replay_at(input, character->after_group);
    return (GuardGroupStatus)character->group_status;
}

static bool known_ordinary_alternative(const GuardLookahead *input) {
    const GuardCache *cache = input->cache;
    if (!cache || cache->ordinary_capacity == 0) return false;
    const uint32_t offset = input->replay ? input->offset : guard_source_offset(input->source);
    return offset / 8 < cache->ordinary_capacity && (cache->ordinary_alternatives[offset / 8] >> (offset % 8)) & 1;
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

static void commit_ordinary_alternatives(GuardLookahead *input, bool saw_type_arrow) {
    if (input->pending_count == 0) return;
    GuardCache *cache = input->cache;
    const size_t needed = cache->pending_alternatives[input->pending_count - 1].offset / 8 + 1;
    if (needed > cache->ordinary_capacity) {
        const size_t capacity = cache->ordinary_capacity * 2 > needed ? cache->ordinary_capacity * 2 : needed;
        uint8_t *bits = ts_realloc(cache->ordinary_alternatives, capacity);
        if (!bits) return;
        memset(bits + cache->ordinary_capacity, 0, capacity - cache->ordinary_capacity);
        cache->ordinary_alternatives = bits;
        cache->ordinary_capacity = capacity;
    }
    for (size_t index = 0; index < input->pending_count; index++) {
        const GuardProbePoint *point = &cache->pending_alternatives[index];
        if (saw_type_arrow && !point->retains_type_arrows) continue;
        const uint32_t offset = point->offset;
        cache->ordinary_alternatives[offset / 8] |= (uint8_t)(1u << (offset % 8));
    }
}

#endif
