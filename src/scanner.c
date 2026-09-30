#include "tree_sitter/parser.h"

#include "tree_sitter/alloc.h"

#include "letter_ranges.h"

#include <string.h>
#include <wctype.h>

enum TokenType {
    SEMI,
    CLASS_MEMBER_SEMI,
    BLOCK_COMMENT,
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

// Tells a letter as Kotlin identifiers use it (\p{L}), which `iswalpha` does only for ASCII in the C locale.
static bool is_letter(int32_t c) {
    if (c < 0x80) {
        return iswalpha(c);
    }
    size_t low = 0;
    size_t high = sizeof(LETTER_RANGES) / sizeof(LETTER_RANGES[0]);
    while (low < high) {
        size_t middle = (low + high) / 2;
        if ((uint32_t)c < LETTER_RANGES[middle][0]) {
            high = middle;
        } else if ((uint32_t)c > LETTER_RANGES[middle][1]) {
            low = middle + 1;
        } else {
            return true;
        }
    }
    return false;
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

// Skips the rest of a block comment after its `/*`. Block comments nest in Kotlin.
static void skip_block_comment_rest(TSLexer *lexer) {
    unsigned depth = 1;
    while (depth > 0 && !lexer->eof(lexer)) {
        int32_t c = lexer->lookahead;
        skip(lexer);
        if (c == '*' && lexer->lookahead == '/') {
            skip(lexer);
            depth--;
        } else if (c == '/' && lexer->lookahead == '*') {
            skip(lexer);
            depth++;
        }
    }
}

// Skips whitespace and comments, but only up to the end of the line unless `across_lines` is set. Returns false when
// it stops after consuming a `/` that starts no comment.
static bool skip_whitespace_and_comments(TSLexer *lexer, bool across_lines) {
    for (;;) {
        while (across_lines ? iswspace(lexer->lookahead) : lexer->lookahead == ' ' || lexer->lookahead == '\t') {
            skip(lexer);
        }
        if (lexer->lookahead != '/') {
            return true;
        }
        skip(lexer);
        if (lexer->lookahead == '*') {
            skip(lexer);
            skip_block_comment_rest(lexer);
        } else if (lexer->lookahead == '/') {
            while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
                skip(lexer);
            }
            if (!across_lines) {
                return true;
            }
        } else {
            return false;
        }
    }
}

// Bounds the recursion through string templates that nest strings, so that crafted input cannot overflow the stack.
#define MAX_TEMPLATE_NESTING 16

static bool skip_literal_rest(TSLexer *lexer, int32_t quote, unsigned nesting);

// Skips code up to the bracket that closes the one just skipped, past nested brackets, literals, and comments.
// Returns false at the end of the input or when templates nest too deeply.
static bool skip_to_closing_bracket(TSLexer *lexer, int32_t open, int32_t close, unsigned nesting) {
    unsigned depth = 1;
    while (depth > 0) {
        int32_t c = lexer->lookahead;
        if (lexer->eof(lexer)) {
            return false;
        }
        if (c == '/') {
            skip_whitespace_and_comments(lexer, true);
            continue;
        }
        skip(lexer);
        if (c == open) {
            depth++;
        } else if (c == close) {
            depth--;
        } else if ((c == '"' || c == '\'' || c == '`') && !skip_literal_rest(lexer, c, nesting)) {
            return false;
        }
    }
    return true;
}

// Skips the rest of a string or character literal or a backticked name after its opening quote, including the
// expressions of string templates. Returns false where `skip_to_closing_bracket` does.
static bool skip_literal_rest(TSLexer *lexer, int32_t quote, unsigned nesting) {
    bool raw = false;
    if (quote == '"' && lexer->lookahead == '"') {
        skip(lexer);
        if (lexer->lookahead != '"') {
            return true;
        }
        skip(lexer);
        raw = true;
    }
    // A raw string ends at the last of three or more quotes.
    unsigned quotes = 0;
    while (!lexer->eof(lexer) && (raw ? quotes < 3 || lexer->lookahead == '"' : lexer->lookahead != quote)) {
        int32_t c = lexer->lookahead;
        quotes = c == '"' ? quotes + 1 : 0;
        skip(lexer);
        // Only single-line strings and character literals have escapes.
        if (c == '\\' && !raw && quote != '`') {
            skip(lexer);
        } else if (c == '$' && quote == '"' && lexer->lookahead == '{') {
            skip(lexer);
            if (nesting == MAX_TEMPLATE_NESTING || !skip_to_closing_bracket(lexer, '{', '}', nesting + 1)) {
                return false;
            }
        }
    }
    if (!raw) {
        skip(lexer);
    }
    return true;
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

typedef struct {
    // The leading dollars of a run that the last string content token did not cover although they are content, since
    // the run ends in an interpolation (see `scan_multi_dollar_string_part`).
    uint32_t surplus_dollars;
    // The open multi-dollar strings, innermost last, since an interpolation may contain another string. Each entry is
    // the string's dollar count, with MULTILINE_FLAG set for a multiline string.
    unsigned length;
    uint16_t strings[(TREE_SITTER_SERIALIZATION_BUFFER_SIZE - sizeof(uint32_t)) / sizeof(uint16_t)];
} Scanner;

#define MULTILINE_FLAG 0x8000
#define MAX_DOLLAR_COUNT 0x7fff

void *tree_sitter_kotlin_external_scanner_create() { return ts_calloc(1, sizeof(Scanner)); }

void tree_sitter_kotlin_external_scanner_destroy(void *payload) { ts_free(payload); }

unsigned tree_sitter_kotlin_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    memcpy(buffer, &scanner->surplus_dollars, sizeof(uint32_t));
    memcpy(buffer + sizeof(uint32_t), scanner->strings, scanner->length * sizeof(uint16_t));
    return sizeof(uint32_t) + scanner->length * sizeof(uint16_t);
}

void tree_sitter_kotlin_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    scanner->surplus_dollars = 0;
    scanner->length = 0;
    if (length >= sizeof(uint32_t)) {
        memcpy(&scanner->surplus_dollars, buffer, sizeof(uint32_t));
        scanner->length = (length - sizeof(uint32_t)) / sizeof(uint16_t);
        memcpy(scanner->strings, buffer + sizeof(uint32_t), length - sizeof(uint32_t));
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

// Scans the content of the innermost multi-dollar string up to an interpolation or the closing quotes, or else
// those. Content ends before a run of dollars that starts an interpolation, and the run's leading dollars beyond
// the string's dollar count are content. A token cannot end at a position already passed, so when such a run starts
// a token, the first dollar is returned as content and the rest of the surplus, now counted, as the next token.
// Closing quotes work alike, one quote at a time: in a multiline string, the last three quotes of a run close it.
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
                    } else {
                        scanner->surplus_dollars = run - dollar_count - 1;
                    }
                }
                return true;
            }
            case '"': {
                advance(lexer);
                if (!has_content) {
                    lexer->mark_end(lexer);
                }
                unsigned run = 1;
                while (multiline && lexer->lookahead == '"' && run < 3) {
                    advance(lexer);
                    run++;
                }
                if (multiline && run < 3) {
                    has_content = true;
                    break;
                }
                if (has_content) {
                    return true;
                }
                // A fourth quote makes the first one content.
                if (multiline && lexer->lookahead == '"') {
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

bool tree_sitter_kotlin_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;
    // During error recovery every token is valid, including string content and a semicolon, which never are
    // together otherwise. Scanning string content there would consume the rest of the input on each
    // recovery attempt, making recovery quadratic in the input length.
    bool error_recovery = valid_symbols[MULTILINE_STRING_CONTENT] && valid_symbols[SEMI];
    if (valid_symbols[MULTI_DOLLAR_STRING_CONTENT] && !error_recovery && scanner->length > 0) {
        return scan_multi_dollar_string_part(scanner, lexer);
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
                    if (iswalpha(lexer->lookahead) || lexer->lookahead == '{') {
                        return did_advance;
                    }
                    did_advance = true;
                    break;
                case '"':
                    lexer->mark_end(lexer);
                    // 3 or 4 quotes means we're done
                    advance(lexer);
                    if (lexer->lookahead == '"') {
                        advance(lexer);
                        if (lexer->lookahead == '"') {
                            advance(lexer);
                            if (lexer->lookahead == '"') {
                                advance(lexer);
                            }
                            return did_advance;
                        }
                    }
                    did_advance = true;
                    break;
                default:
                    advance(lexer);
                    did_advance = true;
                    break;
            }
        }
    }

    if (valid_symbols[SEMI] || valid_symbols[CLASS_MEMBER_SEMI]) {
        lexer->result_symbol = valid_symbols[SEMI] ? SEMI : CLASS_MEMBER_SEMI;
        lexer->mark_end(lexer);
        bool saw_newline = false;
        for (;;) {
            if (lexer->eof(lexer)) {
                return true;
            }

            if (lexer->lookahead == ';') {
                advance(lexer);
                lexer->mark_end(lexer);
                return true;
            }

            if (!iswspace(lexer->lookahead)) {
                break;
            }

            if (lexer->lookahead == '\n') {
                skip(lexer);
                saw_newline = true;
                break;
            }

            if (lexer->lookahead == '\r') {
                skip(lexer);

                if (lexer->lookahead == '\n') {
                    skip(lexer);
                }

                saw_newline = true;
                break;
            }

            skip(lexer);
        }

        // Skip whitespace and comments
        while (iswspace(lexer->lookahead)) {
            skip(lexer);
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
                case 'i':
                    return scan_word(lexer, "import");
                // A string after an expression that may end here, e.g. `return $$"…"`.
                case '$':
                    return can_start_multi_dollar_string && scan_multi_dollar_string_start(scanner, lexer, valid_symbols);
                case ';':
                    advance(lexer);
                    lexer->mark_end(lexer);
                    return true;
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
                skipped_modifiers = skip_modifier_words(lexer, scanned_word, true);
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
                    (const char[16][16]){"else", "in", "instanceof", "get", "set", "constructor", "by", "as", "where"},
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
                    // During error recovery, scanning a parameter list to its end on every attempt would make recovery
                    // quadratic in the input length.
                    return !(valid_symbols[index == 3 ? GET : SET] && !error_recovery && scan_accessor_rest(lexer, index == 4));
                }
                // If `in` was found and this specific external keyword is valid,
                // return a semi since it's being used in a range test
                else if (index == 1 && valid_symbols[IN]) {
                    return true;
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
                    while (!lexer->eof(lexer) && !iswspace(lexer->lookahead)) {
                        skip(lexer);
                    }
                    while (iswspace(lexer->lookahead)) {
                        skip(lexer);
                    }
                    char ctor[12] = "constructor";
                    for (uint8_t i = 0; i < 11; i++) {
                        if (lexer->lookahead != ctor[i]) {
                            return true;
                        }
                        skip(lexer);
                    }
                    return false;
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
        }
    }

comment:
    if (valid_symbols[DOLLAR]) {
        return false;
    }

    if (lexer->lookahead == '/') {
        advance(lexer);
        if (lexer->lookahead != '*') {
            return false;
        }
        advance(lexer);

        bool after_star = false;
        unsigned nesting_depth = 1;
        for (;;) {
            switch (lexer->lookahead) {
                case '\0':
                    return false;
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
