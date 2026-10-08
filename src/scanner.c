#include "tree_sitter/parser.h"

#include "tree_sitter/alloc.h"

#include "letter_ranges.h"

#include <string.h>
#include <wctype.h>

enum TokenType {
    DESTRUCTURING_TYPE_START,
    SEMI,
    CLASS_MEMBER_SEMI,
    SAME_LINE_MEMBER_END,
    BLOCK_COMMENT,
    LINE_COMMENT,
    NOT_IS,
    IN,
    Q_DOT,
    MULTILINE_STRING_CONTENT,
    MULTI_DOLLAR_STRING_START,
    MULTI_DOLLAR_MULTILINE_STRING_START,
    MULTI_DOLLAR_STRING_CONTENT,
    MULTI_DOLLAR_INTERPOLATION_START,
    MULTI_DOLLAR_STRING_END,
    CONSTRUCTOR,
    GET,
    SET,
    DOLLAR,
    VAL,
    PRIMARY_CONSTRUCTOR_POSITION,
    DELEGATION_END,
    ARGUMENTS_END,
    OPEN_STATEMENTS,
    OPEN_MEMBERS,
    CLOSE_BRACES,
    TOP_LEVEL_STATEMENT_END,
    CONTEXT_END,
    KEYWORD_REFERENCE,
    KEYWORD_REFERENCE_END,
    WHERE,
    SEPARATED_MEMBER_START,
    UNSEPARATED_MEMBER_START,
    INFIX_POSITION,
    COMPANION_NAME_POSITION,
    TRY_CONTINUATION_POSITION,
    INFIX_GET_IDENTIFIER,
};

#define MAX_WORD_SIZE 16
#define MAX_WORDS 20

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static bool scan_word(TSLexer *lexer, const char *const word) {
    for (uint8_t i = 0; word[i] != '\0'; i++) {
        if (lexer->lookahead != word[i]) {
            return false;
        }
        skip(lexer);
    }
    return true;
}

// Any non-ASCII character may be a letter, which `iswalpha` does not tell in the C locale.
static inline bool is_identifier_part(int32_t c) { return iswalnum(c) || c == '_' || c > 0x7f; }

static bool scan_words(TSLexer *lexer, const char words[MAX_WORDS][MAX_WORD_SIZE], char scanned_word[16],
                       uint8_t *index) {
    // A word is a whole identifier, so that e.g. `value_x` does not match `value`.
    if (!scanned_word[0]) {
        for (uint8_t i = 0; i < MAX_WORD_SIZE - 1; i++) {
            if (!(i == 0 ? iswalpha(lexer->lookahead) : is_identifier_part(lexer->lookahead))) {
                if (i == 0) {
                    return false;
                }
                break;
            }
            // No keyword has a non-ASCII character, which a cast could turn into an ASCII one.
            scanned_word[i] = lexer->lookahead > 0x7f ? '?' : (char)lexer->lookahead;
            skip(lexer);
        }
    }

    // A list ends at its first empty word.
    for (uint8_t i = 0; i < MAX_WORDS && words[i][0]; i++) {
        if (strncmp(scanned_word, words[i], MAX_WORD_SIZE) == 0) {
            if (index != NULL) {
                *index = i;
            }
            return true;
        }
    }

    return false;
}

static const char MODIFIER_WORDS[MAX_WORDS][MAX_WORD_SIZE] = {
    "public",   "private", "protected",   "internal", "abstract", "final",   "open",   "override",
    "lateinit", "vararg",  "noinline", "crossinline", "external", "suspend", "inline",
};

// The other modifiers. Only a declaration after a lone modifier skips them: after an expression, the words above are
// skipped just so that accessor modifiers (`internal set`) reach the accessor check, and these are common names.
static const char OTHER_MODIFIER_WORDS[MAX_WORDS][MAX_WORD_SIZE] = {
    "data",  "enum",     "sealed",  "inner", "value",  "annotation",
    "const", "operator", "tailrec", "infix", "expect", "actual",
};

static const char DECLARATION_KEYWORDS[MAX_WORDS][MAX_WORD_SIZE] = {
    "fun", "val", "var", "class", "interface", "object", "typealias",
};

static bool in_ranges(int32_t c, const uint32_t ranges[][2], size_t count) {
    size_t low = 0;
    size_t high = count;
    while (low < high) {
        size_t middle = (low + high) / 2;
        if ((uint32_t)c < ranges[middle][0]) {
            high = middle;
        } else if ((uint32_t)c > ranges[middle][1]) {
            low = middle + 1;
        } else {
            return true;
        }
    }
    return false;
}

// Tells a letter as Kotlin identifiers use it (\p{L}), which `iswalpha` does only for ASCII in the C locale.
static bool is_letter(int32_t c) {
    return c < 0x80 ? iswalpha(c) : in_ranges(c, LETTER_RANGES, sizeof(LETTER_RANGES) / sizeof(LETTER_RANGES[0]));
}

// Tells a character that continues a name in a string template (`[\p{L}_\p{Nd}]`).
static bool is_template_name_part(int32_t c) {
    return c < 0x80 ? iswalnum(c) || c == '_'
                    : in_ranges(c, NAME_PART_RANGES, sizeof(NAME_PART_RANGES) / sizeof(NAME_PART_RANGES[0]));
}

static inline bool is_identifier_start(int32_t c) { return is_letter(c) || c == '_'; }

// Skips modifier words, leaving the next word, if any, in `scanned_word`. Returns whether it skipped any.
static bool skip_modifier_words(TSLexer *lexer, char scanned_word[MAX_WORD_SIZE], bool all) {
    bool skipped = false;
    while (scan_words(lexer, MODIFIER_WORDS, scanned_word, NULL) ||
           (all && scan_words(lexer, OTHER_MODIFIER_WORDS, scanned_word, NULL))) {
        skipped = true;
        memset(scanned_word, 0, MAX_WORD_SIZE);
        while (iswspace(lexer->lookahead)) {
            skip(lexer);
        }
    }
    return skipped;
}

static void scan_block_comment_rest(TSLexer *lexer, bool skip_chars) {
    unsigned depth = 1;
    while (depth > 0 && !lexer->eof(lexer)) {
        int32_t c = lexer->lookahead;
        lexer->advance(lexer, skip_chars);
        if (c == '*' && lexer->lookahead == '/') {
            lexer->advance(lexer, skip_chars);
            depth--;
        } else if (c == '/' && lexer->lookahead == '*') {
            lexer->advance(lexer, skip_chars);
            depth++;
        }
    }
}

static bool scan_whitespace_and_comments(TSLexer *lexer, bool across_lines, bool skip_chars) {
    for (;;) {
        while (across_lines ? iswspace(lexer->lookahead) : lexer->lookahead == ' ' || lexer->lookahead == '\t') {
            lexer->advance(lexer, skip_chars);
        }
        if (lexer->lookahead != '/') {
            return true;
        }
        lexer->advance(lexer, skip_chars);
        if (lexer->lookahead == '*') {
            lexer->advance(lexer, skip_chars);
            scan_block_comment_rest(lexer, skip_chars);
        } else if (lexer->lookahead == '/') {
            while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
                lexer->advance(lexer, skip_chars);
            }
            if (!across_lines) {
                return true;
            }
        } else {
            return false;
        }
    }
}

static bool skip_whitespace_and_comments(TSLexer *lexer, bool across_lines) {
    return scan_whitespace_and_comments(lexer, across_lines, true);
}

// Bounds the recursion through string templates that nest strings, so that crafted input cannot overflow the stack.
#define MAX_TEMPLATE_NESTING 16

static bool scan_literal_rest(TSLexer *lexer, int32_t quote, unsigned nesting, bool skip_chars);

// Skips code up to the bracket that closes the one just skipped, past nested brackets, literals, and comments.
// Returns false at the end of the input or when templates nest too deeply.
static bool scan_to_closing_bracket(TSLexer *lexer, int32_t open, int32_t close, unsigned nesting, bool skip_chars) {
    unsigned depth = 1;
    while (depth > 0) {
        int32_t c = lexer->lookahead;
        if (lexer->eof(lexer)) {
            return false;
        }
        if (c == '/') {
            scan_whitespace_and_comments(lexer, true, skip_chars);
            continue;
        }
        lexer->advance(lexer, skip_chars);
        if (c == open) {
            depth++;
        } else if (c == close) {
            depth--;
        } else if ((c == '"' || c == '\'' || c == '`') && !scan_literal_rest(lexer, c, nesting, skip_chars)) {
            return false;
        }
    }
    return true;
}

// Skips the rest of a string or character literal or a backticked name after its opening quote, including the
// expressions of string templates. Returns false where `skip_to_closing_bracket` does.
static bool scan_literal_rest(TSLexer *lexer, int32_t quote, unsigned nesting, bool skip_chars) {
    bool raw = false;
    if (quote == '"' && lexer->lookahead == '"') {
        lexer->advance(lexer, skip_chars);
        if (lexer->lookahead != '"') {
            return true;
        }
        lexer->advance(lexer, skip_chars);
        raw = true;
    }
    // A raw string ends at the last of three or more quotes.
    unsigned quotes = 0;
    while (!lexer->eof(lexer) && (raw ? quotes < 3 || lexer->lookahead == '"' : lexer->lookahead != quote)) {
        int32_t c = lexer->lookahead;
        quotes = c == '"' ? quotes + 1 : 0;
        lexer->advance(lexer, skip_chars);
        // Only single-line strings and character literals have escapes.
        if (c == '\\' && !raw && quote != '`') {
            lexer->advance(lexer, skip_chars);
        } else if (c == '$' && quote == '"' && lexer->lookahead == '{') {
            lexer->advance(lexer, skip_chars);
            if (nesting == MAX_TEMPLATE_NESTING || !scan_to_closing_bracket(lexer, '{', '}', nesting + 1, skip_chars)) {
                return false;
            }
        }
    }
    if (!raw) {
        lexer->advance(lexer, skip_chars);
    }
    return true;
}

static bool skip_to_closing_bracket(TSLexer *lexer, int32_t open, int32_t close, unsigned nesting) {
    return scan_to_closing_bracket(lexer, open, close, nesting, true);
}

static bool skip_literal_rest(TSLexer *lexer, int32_t quote, unsigned nesting) {
    return scan_literal_rest(lexer, quote, nesting, true);
}

// Scans the rest of an accessor after `get` or `set`: either nothing more on its line, or a parameter list (empty for
// a getter, starting with the parameter's name or annotation for a setter) followed by a body or a type. The grammar
// accepts accessors after any property, including a local one, which Kotlin does not, so this is what tells a call
// such as `get("a") { … }` or an assignment such as `set = 1` on the next line from an accessor.
static bool scan_accessor_rest(TSLexer *lexer, bool setter) {
    if (!skip_whitespace_and_comments(lexer, false)) {
        return false;
    }
    if (lexer->lookahead != '(') {
        return lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r' || lexer->lookahead == ';' ||
               lexer->lookahead == '}';
    }
    skip(lexer);
    skip_whitespace_and_comments(lexer, true);
    if (setter ? !(is_identifier_start(lexer->lookahead) || lexer->lookahead == '@' || lexer->lookahead == '`')
               : lexer->lookahead != ')') {
        return false;
    }
    // A parenthesis in a literal (e.g. in an annotation's argument) or in a backticked name is not one of the list.
    if (!skip_to_closing_bracket(lexer, '(', ')', 0)) {
        return false;
    }
    skip_whitespace_and_comments(lexer, true);
    return lexer->lookahead == '=' || lexer->lookahead == '{' || lexer->lookahead == ':';
}

static bool scan_catch_parameter_type_end(TSLexer *lexer) {
    skip(lexer);
    if (lexer->lookahead == ':') return false;
    while (!lexer->eof(lexer)) {
        if (!skip_whitespace_and_comments(lexer, true)) return false;
        int32_t c = lexer->lookahead;
        if (c == ')') {
            skip(lexer);
            return skip_whitespace_and_comments(lexer, true) && lexer->lookahead == '{';
        }
        if (c == '{' || c == '}' || c == '=') return false;
        skip(lexer);
        if (c == '(' && !skip_to_closing_bracket(lexer, '(', ')', 0)) return false;
        if (c == '[' && !skip_to_closing_bracket(lexer, '[', ']', 0)) return false;
        if ((c == '\"' || c == '\'' || c == '`') && !skip_literal_rest(lexer, c, 0)) return false;
    }
    return false;
}

static bool scan_catch_parameter_start(TSLexer *lexer) {
    if (!skip_whitespace_and_comments(lexer, true) || lexer->lookahead != '(') return false;
    skip(lexer);
    int32_t previous = 0;
    bool object_name = false;
    while (!lexer->eof(lexer)) {
        if (!skip_whitespace_and_comments(lexer, true)) return false;
        int32_t c = lexer->lookahead;
        if (c == ':') {
            return !object_name && (is_identifier_part(previous) || previous == '`') &&
                   scan_catch_parameter_type_end(lexer);
        }
        if (c == ')' || c == '=' || c == ',' || c == '{' || c == '}' || c == '?') return false;
        if (is_identifier_part(c)) {
            const char *word = "object";
            bool matches = true;
            do {
                previous = lexer->lookahead;
                if (!*word || previous != *word) matches = false;
                else word++;
                skip(lexer);
            } while (is_identifier_part(lexer->lookahead));
            object_name = matches && !*word;
            continue;
        }
        object_name = false;
        skip(lexer);
        if (c == '@') {
            while (is_identifier_part(lexer->lookahead) || lexer->lookahead == '.') skip(lexer);
            if (!skip_whitespace_and_comments(lexer, true)) return false;
            if (lexer->lookahead == ':') skip(lexer);
        }
        previous = c;
        if (c == '(') {
            if (!skip_to_closing_bracket(lexer, '(', ')', 0)) return false;
            previous = ')';
        }
        if (c == '[') {
            if (!skip_to_closing_bracket(lexer, '[', ']', 0)) return false;
            previous = ']';
        }
        if ((c == '"' || c == '\'' || c == '`') && !skip_literal_rest(lexer, c, 0)) return false;
    }
    return false;
}

// Kotlin's hard keywords other than `this`, which a string template cannot reference.
static const char *const TEMPLATE_KEYWORDS[] = {
    "as",  "break", "class", "continue", "do",     "else",    "false",  "for",       "fun",    "if",
    "in",  "interface", "is", "null",   "object", "package", "return", "super",     "throw",  "true",
    "try", "typealias", "typeof", "val", "var",   "when",    "while",
};

// Scans a hard keyword other than `this` right after the `$` of a template, as a whole identifier.
static bool scan_template_keyword(TSLexer *lexer) {
    char word[MAX_WORD_SIZE] = {0};
    for (uint8_t i = 0; i < MAX_WORD_SIZE - 1 && is_template_name_part(lexer->lookahead); i++) {
        if (lexer->lookahead > 0x7f) {
            return false;
        }
        word[i] = (char)lexer->lookahead;
        advance(lexer);
    }
    if (is_template_name_part(lexer->lookahead)) {
        return false;
    }
    for (size_t i = 0; i < sizeof(TEMPLATE_KEYWORDS) / sizeof(TEMPLATE_KEYWORDS[0]); i++) {
        if (strcmp(word, TEMPLATE_KEYWORDS[i]) == 0) {
            lexer->mark_end(lexer);
            lexer->result_symbol = KEYWORD_REFERENCE;
            return true;
        }
    }
    return false;
}

typedef struct {
    TSLexer lexer;
    TSLexer *source;
    unsigned remaining;
} TypeLookahead;

static void advance_type_lookahead(TSLexer *lexer, bool skip);
static bool type_lookahead_eof(const TSLexer *lexer);
static bool scan_destructuring_parameter_arrow(TSLexer *lexer);
static bool can_start_destructuring_type(TSLexer *lexer);

static bool has_destructuring_parameter_arrow(TSLexer *lexer) {
    TypeLookahead lookahead = {
        .lexer = {.lookahead = lexer->lookahead, .advance = advance_type_lookahead, .eof = type_lookahead_eof},
        .source = lexer,
        .remaining = 4096,
    };
    bool found = scan_destructuring_parameter_arrow(&lookahead.lexer);
    // Repeated unfinished annotations must not rescan the rest of the file. At the budget, let the grammar decide
    // instead of imposing a maximum length on valid types, comments or annotation arguments.
    return found || lookahead.remaining == 0;
}

static void advance_type_lookahead(TSLexer *lexer, bool skip) {
    TypeLookahead *lookahead = (TypeLookahead *)lexer;
    if (lookahead->remaining > 0) {
        lookahead->source->advance(lookahead->source, skip);
        lookahead->remaining--;
    }
    lexer->lookahead = lookahead->remaining > 0 ? lookahead->source->lookahead : 0;
}

static bool type_lookahead_eof(const TSLexer *lexer) {
    const TypeLookahead *lookahead = (const TypeLookahead *)lexer;
    return lookahead->remaining == 0 || lookahead->source->eof(lookahead->source);
}

static bool scan_destructuring_parameter_arrow(TSLexer *lexer) {
    if (!skip_whitespace_and_comments(lexer, true) || !can_start_destructuring_type(lexer)) return false;
    while (!lexer->eof(lexer)) {
        if (!skip_whitespace_and_comments(lexer, true)) return false;
        int32_t c = lexer->lookahead;
        if (c == '{' || c == '}' || c == ')' || c == ']' || c == ';' || c == '=' || c == '"' || c == '\'') return false;
        if (lexer->eof(lexer)) return false;
        skip(lexer);
        if (c == '-' && lexer->lookahead == '>') return true;
        if (c == '(' && !skip_to_closing_bracket(lexer, '(', ')', 0)) return false;
        if (c == '[' && !skip_to_closing_bracket(lexer, '[', ']', 0)) return false;
        if (c == '`' && !skip_literal_rest(lexer, c, 0)) return false;
    }
    return false;
}

static bool can_start_destructuring_type(TSLexer *lexer) {
    if (!is_identifier_start(lexer->lookahead)) {
        return lexer->lookahead == '(' || lexer->lookahead == '@' || lexer->lookahead == '`';
    }
    char word[MAX_WORD_SIZE] = {0};
    for (uint8_t i = 0; i < MAX_WORD_SIZE - 1 && is_identifier_part(lexer->lookahead); i++) {
        if (lexer->lookahead > 0x7f) return true;
        word[i] = (char)lexer->lookahead;
        advance(lexer);
    }
    if (is_identifier_part(lexer->lookahead)) return true;
    if (strcmp(word, "this") == 0) return false;
    for (size_t i = 0; i < sizeof(TEMPLATE_KEYWORDS) / sizeof(TEMPLATE_KEYWORDS[0]); i++) {
        if (strcmp(word, TEMPLATE_KEYWORDS[i]) == 0) return false;
    }
    return true;
}

// Frames deeper than this are not recorded and read as statement lists, which nest far more often than class bodies.
#define MAX_FRAMES 256

typedef struct {
    // How many braces that hold statements (blocks, lambdas, and `when` bodies) or members (class bodies) enclose the
    // position.
    uint32_t depth;
    // The leading dollars of a run that the last string content token did not cover although they are content, since
    // the run ends in an interpolation (see `scan_multi_dollar_string_part`).
    uint32_t surplus_dollars;
    // Whether the last token this scanner returned is the start of an interpolation of a name in a multi-dollar string
    // (`$$name`), or a keyword reference right after one.
    uint8_t after_short_template;
    uint8_t same_line_member_end;
    // Bit i tells whether the (i + 1)th enclosing frame from the outside holds statements. As in Kotlin, a property
    // directly in a statement list is a local one, which has no accessors, and a context list of types there is a call.
    uint8_t frames[MAX_FRAMES / 8];
    uint8_t separated_members[MAX_FRAMES / 8];
    // The open multi-dollar strings, innermost last, since an interpolation may contain another string. Each entry is
    // the string's dollar count, with MULTILINE_FLAG set for a multiline string.
    unsigned length;
    uint16_t strings[(TREE_SITTER_SERIALIZATION_BUFFER_SIZE - 2 * sizeof(uint32_t) - 2 - 2 * MAX_FRAMES / 8) /
                     sizeof(uint16_t)];
} Scanner;

static unsigned frame_bytes(uint32_t depth) { return ((depth < MAX_FRAMES ? depth : MAX_FRAMES) + 7) / 8; }

static bool in_statements(const Scanner *scanner) {
    uint32_t i = scanner->depth - 1;
    return scanner->depth > 0 && (i >= MAX_FRAMES || (scanner->frames[i / 8] >> (i % 8)) & 1);
}

static void push_frame(Scanner *scanner, bool statements) {
    uint32_t i = scanner->depth;
    if (i < MAX_FRAMES) {
        scanner->frames[i / 8] |= (uint8_t)((unsigned)statements << (i % 8));
    }
    if (scanner->depth < UINT32_MAX) {
        scanner->depth++;
    }
}

// Clears the popped frame's bit, since tree-sitter compares serialized states byte by byte: the bits above the depth
// must be zero for equal states to serialize equally.
static void pop_frame(Scanner *scanner) {
    if (scanner->depth == 0) {
        return;
    }
    scanner->depth--;
    uint32_t i = scanner->depth;
    if (i < MAX_FRAMES) {
        scanner->frames[i / 8] &= (uint8_t)~(1u << (i % 8));
        scanner->separated_members[i / 8] &= (uint8_t)~(1u << (i % 8));
    }
}

#define MULTILINE_FLAG 0x8000
#define MAX_DOLLAR_COUNT 0x7fff

void *tree_sitter_kotlin_external_scanner_create() { return ts_calloc(1, sizeof(Scanner)); }

void tree_sitter_kotlin_external_scanner_destroy(void *payload) { ts_free(payload); }

unsigned tree_sitter_kotlin_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    unsigned size = 0;
    memcpy(buffer, &scanner->depth, sizeof(uint32_t));
    size += sizeof(uint32_t);
    memcpy(buffer + size, &scanner->surplus_dollars, sizeof(uint32_t));
    size += sizeof(uint32_t);
    buffer[size++] = (char)scanner->after_short_template;
    buffer[size++] = (char)scanner->same_line_member_end;
    memcpy(buffer + size, scanner->frames, frame_bytes(scanner->depth));
    size += frame_bytes(scanner->depth);
    memcpy(buffer + size, scanner->separated_members, frame_bytes(scanner->depth));
    size += frame_bytes(scanner->depth);
    memcpy(buffer + size, scanner->strings, scanner->length * sizeof(uint16_t));
    return size + scanner->length * sizeof(uint16_t);
}

void tree_sitter_kotlin_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    scanner->depth = 0;
    scanner->surplus_dollars = 0;
    scanner->after_short_template = 0;
    scanner->same_line_member_end = 0;
    memset(scanner->frames, 0, sizeof(scanner->frames));
    memset(scanner->separated_members, 0, sizeof(scanner->separated_members));
    scanner->length = 0;
    if (length >= 2 * sizeof(uint32_t) + 2) {
        unsigned size = 0;
        memcpy(&scanner->depth, buffer, sizeof(uint32_t));
        size += sizeof(uint32_t);
        memcpy(&scanner->surplus_dollars, buffer + size, sizeof(uint32_t));
        size += sizeof(uint32_t);
        scanner->after_short_template = (uint8_t)buffer[size++];
        scanner->same_line_member_end = (uint8_t)buffer[size++];
        memcpy(scanner->frames, buffer + size, frame_bytes(scanner->depth));
        size += frame_bytes(scanner->depth);
        memcpy(scanner->separated_members, buffer + size, frame_bytes(scanner->depth));
        size += frame_bytes(scanner->depth);
        scanner->length = (length - size) / sizeof(uint16_t);
        memcpy(scanner->strings, buffer + size, length - size);
    }
}

// Scans `$$"` or `$$"""` with two or more dollars.
static bool scan_multi_dollar_string_start(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    unsigned dollar_count = 0;
    while (lexer->lookahead == '$') {
        advance(lexer);
        dollar_count++;
    }
    if (dollar_count < 2 || dollar_count > MAX_DOLLAR_COUNT || lexer->lookahead != '"' ||
        scanner->length == sizeof(scanner->strings) / sizeof(uint16_t)) {
        return false;
    }
    advance(lexer);
    lexer->mark_end(lexer);
    uint16_t string = (uint16_t)dollar_count;
    lexer->result_symbol = MULTI_DOLLAR_STRING_START;
    if (lexer->lookahead == '"') {
        advance(lexer);
        // `$$""` is an empty single-line string.
        if (lexer->lookahead == '"' && valid_symbols[MULTI_DOLLAR_MULTILINE_STRING_START]) {
            advance(lexer);
            lexer->mark_end(lexer);
            string |= MULTILINE_FLAG;
            lexer->result_symbol = MULTI_DOLLAR_MULTILINE_STRING_START;
        }
    }
    if (!valid_symbols[lexer->result_symbol]) {
        return false;
    }
    scanner->strings[scanner->length++] = string;
    scanner->surplus_dollars = 0;
    return true;
}

// Consumes a quote and, in a multiline string, up to two more, returning how many it consumed. The last three quotes
// of a run close a multiline string and the quotes before them are content. A token cannot end at a position already
// passed, so the token's end is marked before the run, and also after its first quote when the token has no content
// yet: a run of four or more quotes then returns that quote as content, and the next token sees a shorter run.
static unsigned scan_quote_run(TSLexer *lexer, bool multiline, bool has_content) {
    lexer->mark_end(lexer);
    advance(lexer);
    if (!has_content) {
        lexer->mark_end(lexer);
    }
    unsigned run = 1;
    while (multiline && lexer->lookahead == '"' && run < 3) {
        advance(lexer);
        run++;
    }
    return run;
}

// Scans the content of the innermost multi-dollar string up to an interpolation or the closing quotes, or else
// those. Content ends before a run of dollars that starts an interpolation, and the run's leading dollars beyond
// the string's dollar count are content. A token cannot end at a position already passed, so when such a run starts
// a token, the first dollar is returned as content and the rest of the surplus, now counted, as the next token.
static bool scan_multi_dollar_string_part(Scanner *scanner, TSLexer *lexer) {
    uint16_t string = scanner->strings[scanner->length - 1];
    unsigned dollar_count = string & MAX_DOLLAR_COUNT;
    bool multiline = string & MULTILINE_FLAG;
    bool has_content = false;
    lexer->result_symbol = MULTI_DOLLAR_STRING_CONTENT;
    uint32_t surplus_dollars = scanner->surplus_dollars;
    scanner->surplus_dollars = 0;
    if (surplus_dollars > 0) {
        while (surplus_dollars > 0 && lexer->lookahead == '$') {
            advance(lexer);
            surplus_dollars--;
            has_content = true;
        }
        if (has_content) {
            lexer->mark_end(lexer);
            return true;
        }
    }
    for (;;) {
        lexer->mark_end(lexer);
        if (lexer->eof(lexer)) {
            return has_content;
        }
        switch (lexer->lookahead) {
            case '$': {
                advance(lexer);
                if (!has_content) {
                    lexer->mark_end(lexer);
                }
                unsigned run = 1;
                while (lexer->lookahead == '$') {
                    advance(lexer);
                    run++;
                }
                if (run < dollar_count || !(is_identifier_start(lexer->lookahead) || lexer->lookahead == '{')) {
                    has_content = true;
                    break;
                }
                if (!has_content) {
                    if (run == dollar_count) {
                        lexer->mark_end(lexer);
                        lexer->result_symbol = MULTI_DOLLAR_INTERPOLATION_START;
                        scanner->after_short_template = lexer->lookahead != '{';
                    } else {
                        scanner->surplus_dollars = run - dollar_count - 1;
                    }
                }
                return true;
            }
            case '"': {
                unsigned run = scan_quote_run(lexer, multiline, has_content);
                if (multiline && run < 3) {
                    has_content = true;
                    break;
                }
                if (has_content || (multiline && lexer->lookahead == '"')) {
                    return true;
                }
                lexer->mark_end(lexer);
                lexer->result_symbol = MULTI_DOLLAR_STRING_END;
                scanner->length--;
                return true;
            }
            case '\\': {
                bool had_content = has_content;
                advance(lexer);
                has_content = true;
                if (multiline) {
                    break;
                }
                // An escape sequence is a token of its own in a single-line string. What `escape_sequence` does not
                // accept is content, as `string_literal` takes a backslash and any other character as content.
                int32_t escaped = lexer->lookahead;
                if (escaped == 'u') {
                    advance(lexer);
                    unsigned digits = 0;
                    while (digits < 4 && iswxdigit(lexer->lookahead)) {
                        advance(lexer);
                        digits++;
                    }
                    if (digits == 4) {
                        return had_content;
                    }
                } else if (escaped == 'x' || (escaped >= '0' && escaped <= '7')) {
                    advance(lexer);
                } else {
                    return had_content;
                }
                break;
            }
            case '\n':
            case '\r':
                if (!multiline) {
                    return has_content;
                }
                advance(lexer);
                has_content = true;
                break;
            default:
                advance(lexer);
                has_content = true;
                break;
        }
    }
}

static bool scan_infix_get_identifier(TSLexer *lexer, bool can_be_accessor);

bool tree_sitter_kotlin_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;
    // During error recovery every token is valid, including string content and a semicolon, which never are
    // together otherwise. Scanning string content there would consume the rest of the input on each
    // recovery attempt, making recovery quadratic in the input length.
    bool error_recovery = valid_symbols[MULTILINE_STRING_CONTENT] && valid_symbols[SEMI];
    if (!error_recovery && scanner->same_line_member_end && valid_symbols[CLASS_MEMBER_SEMI]) {
        scanner->same_line_member_end = 0;
        lexer->mark_end(lexer);
        lexer->result_symbol = CLASS_MEMBER_SEMI;
        return true;
    }
    scanner->same_line_member_end = 0;
    bool after_short_template = scanner->after_short_template;
    scanner->after_short_template = 0;
    if (!error_recovery && valid_symbols[TOP_LEVEL_STATEMENT_END]) {
        lexer->mark_end(lexer);
        lexer->result_symbol = TOP_LEVEL_STATEMENT_END;
        scanner->depth = 0;
        memset(scanner->frames, 0, sizeof(scanner->frames));
        memset(scanner->separated_members, 0, sizeof(scanner->separated_members));
        return true;
    }
    if (!error_recovery && scanner->depth > 0 && !in_statements(scanner) &&
        (valid_symbols[SEPARATED_MEMBER_START] || valid_symbols[UNSEPARATED_MEMBER_START])) {
        lexer->mark_end(lexer);
        bool separated = valid_symbols[SEPARATED_MEMBER_START];
        lexer->result_symbol = separated ? SEPARATED_MEMBER_START : UNSEPARATED_MEMBER_START;
        uint32_t i = scanner->depth - 1;
        scanner->separated_members[i / 8] &= (uint8_t)~(1u << (i % 8));
        scanner->separated_members[i / 8] |= (uint8_t)((unsigned)separated << (i % 8));
        return true;
    }
    if (valid_symbols[KEYWORD_REFERENCE] && !error_recovery) {
        scanner->after_short_template = after_short_template;
        return scan_template_keyword(lexer);
    }
    if (!error_recovery && valid_symbols[CONTEXT_END] && !in_statements(scanner)) {
        lexer->mark_end(lexer);
        lexer->result_symbol = CONTEXT_END;
        return true;
    }
    if (!error_recovery && (valid_symbols[OPEN_STATEMENTS] || valid_symbols[OPEN_MEMBERS] || valid_symbols[CLOSE_BRACES])) {
        lexer->mark_end(lexer);
        if (valid_symbols[OPEN_STATEMENTS] || valid_symbols[OPEN_MEMBERS]) {
            lexer->result_symbol = valid_symbols[OPEN_STATEMENTS] ? OPEN_STATEMENTS : OPEN_MEMBERS;
            push_frame(scanner, valid_symbols[OPEN_STATEMENTS]);
        } else {
            lexer->result_symbol = CLOSE_BRACES;
            pop_frame(scanner);
        }
        return true;
    }
    if (valid_symbols[MULTI_DOLLAR_STRING_CONTENT] && !error_recovery && scanner->length > 0) {
        return scan_multi_dollar_string_part(scanner, lexer);
    }
    // After a keyword reference in a multi-dollar string, the string goes on: lexing its next part, which is not valid
    // there, lets error recovery insert the missing end of the reference and keep the string, instead of leaving the
    // string open to the end of the input. A reference in a string nested in an interpolation is not in it. Where the
    // part scan leaves the next part to the grammar (an escape sequence, a line break, or the end of the input), an
    // empty part serves instead.
    if (valid_symbols[KEYWORD_REFERENCE_END] && after_short_template && !error_recovery && scanner->length > 0) {
        if (!scan_multi_dollar_string_part(scanner, lexer)) {
            lexer->result_symbol = MULTI_DOLLAR_STRING_CONTENT;
        } else if (lexer->result_symbol == MULTI_DOLLAR_INTERPOLATION_START && scanner->after_short_template) {
            // Error recovery cannot also recover from a second reference right after this one, so the next one is
            // content: the string has an error already.
            if (scan_template_keyword(lexer)) {
                lexer->result_symbol = MULTI_DOLLAR_STRING_CONTENT;
                scanner->after_short_template = 0;
            } else {
                lexer->result_symbol = MULTI_DOLLAR_INTERPOLATION_START;
            }
        }
        return true;
    }
    bool can_start_multi_dollar_string =
        !error_recovery && (valid_symbols[MULTI_DOLLAR_STRING_START] || valid_symbols[MULTI_DOLLAR_MULTILINE_STRING_START]);
    if (valid_symbols[MULTILINE_STRING_CONTENT] && !error_recovery) {
        bool did_advance = false;
        lexer->result_symbol = MULTILINE_STRING_CONTENT;
        while (!lexer->eof(lexer)) {
            switch (lexer->lookahead) {
                case '$':
                    lexer->mark_end(lexer);
                    advance(lexer);
                    if (is_identifier_start(lexer->lookahead) || lexer->lookahead == '{') {
                        return did_advance;
                    }
                    did_advance = true;
                    break;
                case '"': {
                    unsigned run = scan_quote_run(lexer, true, did_advance);
                    if (run < 3) {
                        did_advance = true;
                        break;
                    }
                    return did_advance || lexer->lookahead == '"';
                }
                default:
                    advance(lexer);
                    did_advance = true;
                    break;
            }
        }
    }

    if (!error_recovery && valid_symbols[SAME_LINE_MEMBER_END] && scanner->depth > 0 && !in_statements(scanner) &&
        !(scanner->separated_members[(scanner->depth - 1) / 8] & (1u << ((scanner->depth - 1) % 8)))) {
        lexer->mark_end(lexer);
        while (iswspace(lexer->lookahead) && lexer->lookahead != '\n' && lexer->lookahead != '\r') skip(lexer);
        if (iswalpha(lexer->lookahead)) {
            char scanned_word[16] = {0};
            while (scan_words(lexer, MODIFIER_WORDS, scanned_word, NULL) ||
                   scan_words(lexer, OTHER_MODIFIER_WORDS, scanned_word, NULL)) {
                memset(scanned_word, 0, MAX_WORD_SIZE);
                if (!skip_whitespace_and_comments(lexer, true)) return false;
            }
            if (scan_words(lexer, DECLARATION_KEYWORDS, scanned_word, NULL) ||
                (!valid_symbols[INFIX_POSITION] && !valid_symbols[COMPANION_NAME_POSITION] &&
                 (strcmp(scanned_word, "init") == 0 ||
                  (strcmp(scanned_word, "constructor") == 0 && !valid_symbols[PRIMARY_CONSTRUCTOR_POSITION]) ||
                  strcmp(scanned_word, "companion") == 0))) {
                scanner->same_line_member_end = 1;
                lexer->result_symbol = SAME_LINE_MEMBER_END;
                return true;
            }
            return false;
        }
    }
    bool can_end_delegation = valid_symbols[DELEGATION_END] && !error_recovery;
    bool saw_newline = false;
    if (valid_symbols[SEMI] || valid_symbols[CLASS_MEMBER_SEMI] || can_end_delegation) {
        // Both tokens are empty and end where the previous token does.
        lexer->mark_end(lexer);
        while (iswspace(lexer->lookahead)) {
            saw_newline = saw_newline || lexer->lookahead == '\n' || lexer->lookahead == '\r';
            skip(lexer);
        }
        // As in Kotlin, a `{` right after a delegation expression in a class header starts the class body, never a
        // trailing lambda of the expression.
        if (can_end_delegation && lexer->lookahead == '{') {
            lexer->result_symbol = DELEGATION_END;
            return true;
        }
    }

    if (valid_symbols[SEMI] || valid_symbols[CLASS_MEMBER_SEMI]) {
        lexer->result_symbol = valid_symbols[SEMI] ? SEMI : CLASS_MEMBER_SEMI;
        if (lexer->eof(lexer)) {
            return true;
        }
        if (lexer->lookahead == ';') {
            advance(lexer);
            lexer->mark_end(lexer);
            return true;
        }
        if (lexer->lookahead == '/') {
            goto comment;
        }

        if (!saw_newline) {
            switch (lexer->lookahead) {
                case '!':
                    skip(lexer);
                    goto continue_not_is_from_semi;
                case '?':
                    if (valid_symbols[Q_DOT]) {
                        goto q_dot_from_semi;
                    }
                    return false;
                case 'g':
                    if (!error_recovery && valid_symbols[INFIX_GET_IDENTIFIER] && scan_infix_get_identifier(lexer, valid_symbols[GET])) {
                        lexer->result_symbol = INFIX_GET_IDENTIFIER;
                        return true;
                    }
                    return false;
                case 'i':
                    return scan_word(lexer, "import");
                // A string after an expression that may end here, e.g. `return $$"…"`.
                case '$':
                    return can_start_multi_dollar_string && scan_multi_dollar_string_start(scanner, lexer, valid_symbols);
                // A class member may end on the line that closes its body (`class A { val x = 1 }`).
                case '}':
                    return valid_symbols[CLASS_MEMBER_SEMI] && !valid_symbols[SEMI];
                default:
                    return false;
            }
        }

        char scanned_word[16] = {0};
        bool skipped_modifiers = false;
        // Where a statement may end, `val` is valid only after a modifier that `_reserved_identifier` also reads as a
        // whole statement (`private` alone on its line). As in Kotlin, the modifier then belongs to a declaration that
        // starts on the next line, possibly with more modifiers or annotations.
        if (valid_symbols[VAL] && !error_recovery) {
            if (lexer->lookahead == '@') {
                return false;
            }
            if (iswalpha(lexer->lookahead)) {
                // Modifiers not followed by a declaration, as in `open = 1` or `sealed = 1`, start a statement of their own.
                // A context parameter list (`context(…)`) may stand among the modifiers.
                for (;;) {
                    skipped_modifiers = skip_modifier_words(lexer, scanned_word, true) || skipped_modifiers;
                    if (strncmp(scanned_word, "context", MAX_WORD_SIZE) != 0 ||
                        !skip_whitespace_and_comments(lexer, true) || lexer->lookahead != '(') {
                        break;
                    }
                    skip(lexer);
                    if (!skip_to_closing_bracket(lexer, '(', ')', 0) || !skip_whitespace_and_comments(lexer, true)) {
                        break;
                    }
                    memset(scanned_word, 0, MAX_WORD_SIZE);
                    skipped_modifiers = true;
                }
                if ((!scanned_word[0] && lexer->lookahead == '@') ||
                    scan_words(lexer, DECLARATION_KEYWORDS, scanned_word, NULL)) {
                    return false;
                }
                goto keywords;
            }
        }
    _switch:
        switch (lexer->lookahead) {
            case ',':
            case '.':
            case ':':
            case '*':
            case '%':
            case '>':
            case '<':
            case '=':
            case '{':
            case '[':
            case '|':
            case '&':
            case '/':
                return false;
            // Insert a semicolon before `--` and `++`, but not before binary `+` or `-`.
            // Insert before +/-{float}
            case '+':
                skip(lexer);
                if (lexer->lookahead == '+') {
                    return true;
                }
                return iswdigit(lexer->lookahead);
            case '-':
                skip(lexer);
                if (lexer->lookahead == '-') {
                    return true;
                }
                return iswdigit(lexer->lookahead);
            // Don't insert a semicolon before `!=`, but do insert one before a unary `!`.
            case '!':
                skip(lexer);
                if (lexer->lookahead == 'i' && valid_symbols[NOT_IS]) {
                    skip(lexer);
                    if (lexer->lookahead == 's') {
                        skip(lexer);
                        if (!iswalnum(lexer->lookahead)) {
                            return true;
                        }
                    }
                }
                return lexer->lookahead != '=';
            case '?':
                if (valid_symbols[Q_DOT]) {
                    goto q_dot_from_semi;
                }
                return true;
            case 'e':
            case 'i':
            case 'g':
            case 's':
            case 'p':
            case 'a':
            case 'f':
            case 'o':
            case 'l':
            case 'v':
            case 'n':
            case 'c':
            case 'b':
            case 'w':
                skipped_modifiers = skip_modifier_words(lexer, scanned_word, false);
            keywords:;
                uint8_t index = -1;
                bool res = scan_words(
                    lexer,
                    (const char[16][16]){"else", "in", "instanceof", "get", "set", "constructor", "by", "as", "where", "catch", "finally"},
                    scanned_word, &index);
                // Of these, only an accessor or a constructor follows modifiers; in `private as T`, `private` is a name.
                if (skipped_modifiers && index != 3 && index != 4 && index != 5) {
                    return true;
                }

                // If `CLASS_MEMBER_SEMI` is valid, we found a secondary constructor and so we want to insert a semi, OR
                // we found a variable named constructor whose field is being accessed
                if (index == 5) {
                    while (iswspace(lexer->lookahead)) {
                        skip(lexer);
                    }
                    if (valid_symbols[CLASS_MEMBER_SEMI] || lexer->lookahead == '.' || lexer->lookahead == '=') {
                        return true;
                    }
                }
                // Ordinarily, we should not insert a semicolon if there is an `else` on the next line,
                // except for when it's a 'when entry', which has a `->` after the `else`.
                else if (index == 0) {
                    while (iswspace(lexer->lookahead)) {
                        skip(lexer);
                    }
                    if (lexer->lookahead == '-') {
                        skip(lexer);
                        if (lexer->lookahead == '>') {
                            return true;
                        }
                    }
                }
                // A `get` or `set` that does not start an accessor starts a statement, e.g. a call.
                else if (index == 3 || index == 4) {
                    // A local property has no accessors, as in Kotlin, so after one `get` or `set` starts a statement.
                    if (valid_symbols[SEMI] && in_statements(scanner)) {
                        return true;
                    }
                    // During error recovery, scanning a parameter list to its end on every attempt would make recovery
                    // quadratic in the input length.
                    return !(valid_symbols[index == 3 ? GET : SET] && !error_recovery && scan_accessor_rest(lexer, index == 4));
                }
                // If `in` was found and this specific external keyword is valid,
                // return a semi since it's being used in a range test
                else if (index == 1 && valid_symbols[IN]) {
                    return true;
                }
                else if (index == 8) {
                    return !valid_symbols[WHERE];
                }
                else if (index == 9 || index == 10) {
                    if (error_recovery || !valid_symbols[TRY_CONTINUATION_POSITION]) return true;
                    if (index == 9) return !scan_catch_parameter_start(lexer);
                    return !skip_whitespace_and_comments(lexer, true) || lexer->lookahead != '{';
                }
                return !res;
            case ';':
                advance(lexer);
                lexer->mark_end(lexer);
                return true;
            // Kotlin allows a primary constructor on the line after the class name. During error recovery, where every
            // token is valid, a `(` on a new line still starts a statement.
            case '(':
                return error_recovery || !valid_symbols[PRIMARY_CONSTRUCTOR_POSITION];
            case '@':
                if (valid_symbols[CONSTRUCTOR]) {
                    unsigned parentheses = 0, comments = 0, quote_run = 0;
                    int32_t quote = 0, previous = 0;
                    bool escaped = false, ambiguous = false, line_comment = false;
                    while (!lexer->eof(lexer) && !iswspace(lexer->lookahead)) {
                        int32_t c = lexer->lookahead;
                        if (line_comment) {
                            skip(lexer);
                            continue;
                        }
                        quote_run = c == '"' ? quote_run + 1 : 0;
                        ambiguous = ambiguous || quote_run >= 3;
                        if (comments) {
                            if (previous == '/' && c == '*') {
                                comments++;
                                c = 0;
                            } else if (previous == '*' && c == '/') {
                                comments--;
                                c = 0;
                            }
                        } else if (quote) {
                            if (escaped) escaped = false;
                            else if (c == '\\' && quote != '`') escaped = true;
                            else if (c == quote) quote = 0;
                            else if (quote == '"' && c == '$') ambiguous = true;
                        } else if (previous == '/' && c == '*') {
                            comments++;
                            c = 0;
                        } else if (previous == '/' && c == '/') {
                            line_comment = true;
                            c = 0;
                        } else if (c == '"' || c == '\'' || c == '`') quote = c;
                        else if (c == '(') parentheses++;
                        else if (c == ')' && parentheses) parentheses--;
                        previous = c;
                        skip(lexer);
                    }
                    while (iswspace(lexer->lookahead)) {
                        skip(lexer);
                    }
                    char scanned_word[MAX_WORD_SIZE] = {0};
                    bool modifiers = skip_modifier_words(lexer, scanned_word, false);
                    if (!modifiers) return strncmp(scanned_word, "constructor", 11) != 0;
                    if (parentheses || comments || quote || ambiguous || line_comment) return true;
                    if (!scan_words(lexer, (const char[16][16]){"constructor"}, scanned_word, NULL)) return true;
                    while (iswspace(lexer->lookahead)) skip(lexer);
                    return lexer->lookahead != '(';
                }
                if (valid_symbols[GET] || valid_symbols[SET]) {
                    bool saw_paren = false;
                    while (!lexer->eof(lexer) && (saw_paren ? lexer->lookahead != '\n' : !iswspace(lexer->lookahead))) {
                        skip(lexer);
                        if (lexer->lookahead == '(') {
                            saw_paren = true;
                        }
                        if (lexer->lookahead == ')') {
                            saw_paren = false;
                        }
                    }
                    while (iswspace(lexer->lookahead)) {
                        skip(lexer);
                    }
                    if (lexer->lookahead == '/') {
                        return true;
                    }
                    goto _switch;
                }
                return true;

            default:
                return true;
        }
    }

    while (iswspace(lexer->lookahead)) {
        skip(lexer);
    }

    if (!error_recovery && valid_symbols[INFIX_GET_IDENTIFIER] && lexer->lookahead == 'g') {
        bool infix = scan_infix_get_identifier(lexer, valid_symbols[GET]);
        if (infix) lexer->result_symbol = INFIX_GET_IDENTIFIER;
        return infix;
    }

    if (valid_symbols[DESTRUCTURING_TYPE_START] && !error_recovery && lexer->lookahead == ':') {
        advance(lexer);
        lexer->mark_end(lexer);
        lexer->result_symbol = DESTRUCTURING_TYPE_START;
        return has_destructuring_parameter_arrow(lexer);
    }

    // The `)` that ends a call's arguments, whose lookahead reaches the next token: whether the call takes a trailing
    // lambda depends on that token, so an edit up to it must reparse the call instead of reusing it. Ending the
    // arguments with one token also lets error recovery insert it as missing when the `)` is absent.
    if (valid_symbols[ARGUMENTS_END] && !error_recovery && lexer->lookahead == ')') {
        advance(lexer);
        lexer->mark_end(lexer);
        lexer->result_symbol = ARGUMENTS_END;
        skip_whitespace_and_comments(lexer, true);
        return true;
    }

    if (lexer->lookahead == '$' && can_start_multi_dollar_string) {
        return scan_multi_dollar_string_start(scanner, lexer, valid_symbols);
    }

    if (valid_symbols[NOT_IS]) {
        if (lexer->lookahead == '!') {
            advance(lexer);
        continue_not_is_from_semi:
            if (lexer->lookahead == 'i') {
                advance(lexer);
                if (lexer->lookahead == 's') {
                    advance(lexer);
                    lexer->result_symbol = NOT_IS;
                    lexer->mark_end(lexer);
                    return !iswalnum(lexer->lookahead);
                }
            }
            // Past a `!` that starts no `!is`, a comment must not be scanned as a token that starts with the `!`.
            return false;
        }
    }

    if (valid_symbols[IN]) {
        if (lexer->lookahead == 'i') {
            advance(lexer);
            if (lexer->lookahead == 'n') {
                advance(lexer);
                lexer->result_symbol = IN;
                lexer->mark_end(lexer);
                return !iswalnum(lexer->lookahead);
            }
            // Past an `i` that starts no `in`, a comment must not be scanned as a token that starts with the `i`.
            return false;
        }
    }

q_dot_from_semi:
    if (valid_symbols[Q_DOT]) {
        while (iswspace(lexer->lookahead)) {
            skip(lexer);
        }
        if (lexer->lookahead == '?') {
            advance(lexer);
            while (iswspace(lexer->lookahead)) {
                skip(lexer);
            }
            if (lexer->lookahead == '.') {
                advance(lexer);
                lexer->result_symbol = Q_DOT;
                lexer->mark_end(lexer);
                return true;
            }
            // The `?` is consumed, so a comment after it must not be scanned as a token that starts with the `?`.
            return false;
        }
    }

comment:
    if (valid_symbols[DOLLAR]) {
        return false;
    }

    if (lexer->lookahead == '/') {
        advance(lexer);
        if (lexer->lookahead == '/') {
            while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
                advance(lexer);
            }
            lexer->mark_end(lexer);
            lexer->result_symbol = LINE_COMMENT;
            return true;
        }
        if (lexer->lookahead != '*') {
            return false;
        }
        advance(lexer);

        bool after_star = false;
        unsigned nesting_depth = 1;
        while (!lexer->eof(lexer)) {
            switch (lexer->lookahead) {
                case '*':
                    advance(lexer);
                    after_star = true;
                    break;
                case '/':
                    if (after_star) {
                        advance(lexer);
                        after_star = false;
                        nesting_depth--;
                        if (nesting_depth == 0) {
                            lexer->result_symbol = BLOCK_COMMENT;
                            lexer->mark_end(lexer);
                            return true;
                        }
                    } else {
                        advance(lexer);
                        after_star = false;
                        if (lexer->lookahead == '*') {
                            nesting_depth++;
                            advance(lexer);
                        }
                    }
                    break;
                default:
                    advance(lexer);
                    after_star = false;
                    break;
            }
        }
    }

    return false;
}

static bool scan_get_following_statement(TSLexer *lexer);
static bool scan_get_following_assignment(TSLexer *lexer);

static bool scan_infix_get_identifier(TSLexer *lexer, bool can_be_accessor) {
    for (const char *word = "get"; *word; word++) {
        if (lexer->lookahead != *word) return false;
        advance(lexer);
    }
    if (is_identifier_part(lexer->lookahead) || lexer->lookahead == '@') return false;
    lexer->mark_end(lexer);
    if (!scan_whitespace_and_comments(lexer, false, false)) return false;
    bool newline = lexer->lookahead == '\n' || lexer->lookahead == '\r';
    if (!scan_whitespace_and_comments(lexer, true, false)) return false;
    if (lexer->eof(lexer) || lexer->lookahead == '}' || lexer->lookahead == ';' || lexer->lookahead == '=') return false;
    if (newline && can_be_accessor) {
        return !scan_get_following_statement(lexer);
    }
    if (lexer->lookahead == ':') {
        advance(lexer);
        if (lexer->lookahead != ':') return false;
    }
    if (lexer->lookahead == '(') {
        advance(lexer);
        if (!scan_whitespace_and_comments(lexer, true, false) || lexer->lookahead == ')') return false;
    }
    return !lexer->eof(lexer) && lexer->lookahead != '}' && lexer->lookahead != ';' && lexer->lookahead != '=';
}

static bool scan_get_following_statement(TSLexer *lexer) {
    bool companion = false;
    for (;;) {
        while (lexer->lookahead == '@') {
            advance(lexer);
            if (!scan_whitespace_and_comments(lexer, true, false)) return false;
            for (;;) {
                if (lexer->lookahead == '[') {
                    advance(lexer);
                    if (!scan_to_closing_bracket(lexer, '[', ']', 0, false) ||
                        !scan_whitespace_and_comments(lexer, true, false)) return false;
                    break;
                }
                if (lexer->lookahead == '`') {
                    advance(lexer);
                    if (!scan_literal_rest(lexer, '`', 0, false)) return false;
                } else {
                    if (!is_identifier_start(lexer->lookahead)) return false;
                    do { advance(lexer); } while (is_identifier_part(lexer->lookahead));
                }
                if (!scan_whitespace_and_comments(lexer, true, false)) return false;
                if (lexer->lookahead == '<') {
                    advance(lexer);
                    if (!scan_to_closing_bracket(lexer, '<', '>', 0, false) ||
                        !scan_whitespace_and_comments(lexer, true, false)) return false;
                }
                if (lexer->lookahead == '.' || lexer->lookahead == ':') {
                    advance(lexer);
                    if (!scan_whitespace_and_comments(lexer, true, false)) return false;
                    continue;
                }
                if (lexer->lookahead == '(') {
                    advance(lexer);
                    if (!scan_to_closing_bracket(lexer, '(', ')', 0, false) ||
                        !scan_whitespace_and_comments(lexer, true, false)) return false;
                }
                break;
            }
        }
        char word[MAX_WORD_SIZE] = {0};
        unsigned length = 0;
        while (is_identifier_part(lexer->lookahead)) {
            if (length < MAX_WORD_SIZE - 1) word[length++] = lexer->lookahead > 0x7f ? '?' : (char)lexer->lookahead;
            else word[MAX_WORD_SIZE - 2] = '?';
            advance(lexer);
        }
        if (!scan_whitespace_and_comments(lexer, false, false)) return lexer->eof(lexer) || scan_get_following_assignment(lexer);
        bool line_after_word = lexer->lookahead == '\n' || lexer->lookahead == '\r';
        if (!scan_whitespace_and_comments(lexer, true, false)) return true;
        if (strcmp(word, "for") == 0 || strcmp(word, "while") == 0 || strcmp(word, "do") == 0) return true;
        if (strcmp(word, "if") == 0 || strcmp(word, "when") == 0 || strcmp(word, "return") == 0 ||
            strcmp(word, "throw") == 0 || strcmp(word, "continue") == 0 || strcmp(word, "break") == 0) return false;
        if (strcmp(word, "fun") == 0) {
            if (lexer->lookahead == '(') return false;
            int32_t previous = 0;
            while (!lexer->eof(lexer) && lexer->lookahead != '(' && lexer->lookahead != '}' && lexer->lookahead != ';') {
                if (!iswspace(lexer->lookahead)) previous = lexer->lookahead;
                advance(lexer);
            }
            return previous != '.';
        }
        if (strcmp(word, "constructor") == 0 && lexer->lookahead == '(') {
            advance(lexer);
            if (!scan_to_closing_bracket(lexer, '(', ')', 0, false) ||
                !scan_whitespace_and_comments(lexer, true, false)) return true;
            return lexer->lookahead == '{' || lexer->lookahead == ':';
        }
        if (strcmp(word, "init") == 0 && lexer->lookahead == '{') return true;
        if (strcmp(word, "object") == 0) {
            return companion || lexer->eof(lexer) || lexer->lookahead == '}' || is_identifier_start(lexer->lookahead) ||
                   lexer->lookahead == '`';
        }
        for (unsigned i = 0; DECLARATION_KEYWORDS[i][0]; i++) {
            if (strcmp(word, DECLARATION_KEYWORDS[i]) == 0) return true;
        }
        bool modifier = strcmp(word, "companion") == 0;
        companion = companion || modifier;
        for (unsigned i = 0; MODIFIER_WORDS[i][0]; i++) {
            modifier = modifier || strcmp(word, MODIFIER_WORDS[i]) == 0;
        }
        for (unsigned i = 0; OTHER_MODIFIER_WORDS[i][0]; i++) {
            modifier = modifier || strcmp(word, OTHER_MODIFIER_WORDS[i]) == 0;
        }
        if (!modifier && lexer->lookahead == '@') {
            advance(lexer);
            if (!scan_whitespace_and_comments(lexer, true, false)) return false;
            continue;
        }
        if (!modifier) return !line_after_word && scan_get_following_assignment(lexer);
        if (!(is_identifier_start(lexer->lookahead) || lexer->lookahead == '@')) return false;
    }
}

static bool scan_get_following_assignment(TSLexer *lexer) {
    while (!lexer->eof(lexer)) {
        int32_t c = lexer->lookahead;
        if (c == '\n' || c == '\r' || c == '}' || c == ';') return false;
        if (c == '/') {
            if (!scan_whitespace_and_comments(lexer, false, false) && lexer->lookahead == '=') return true;
            continue;
        }
        advance(lexer);
        if (c == '=') return lexer->lookahead != '=';
        if ((c == '+' || c == '-' || c == '*' || c == '%') && lexer->lookahead == '=') return true;
        if (c == '<' || c == '>' || c == '!') {
            if (lexer->lookahead == '=') {
                advance(lexer);
                if (c == '!' && lexer->lookahead == '=') advance(lexer);
            }
        } else if (c == '(' || c == '[' || c == '{') {
            int32_t close = c == '(' ? ')' : c == '[' ? ']' : '}';
            if (!scan_to_closing_bracket(lexer, c, close, 0, false)) return false;
        } else if ((c == '"' || c == '\'' || c == '`') && !scan_literal_rest(lexer, c, 0, false)) {
            return false;
        }
    }
    return false;
}
