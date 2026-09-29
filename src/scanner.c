#include "tree_sitter/parser.h"

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
    CONSTRUCTOR,
    GET,
    SET,
    DOLLAR,
    VAL,
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

static bool scan_words(TSLexer *lexer, const char words[MAX_WORDS][MAX_WORD_SIZE], char scanned_word[16],
                       uint8_t *index) {
    if (!scanned_word[0]) {
        for (uint8_t i = 0; i < MAX_WORD_SIZE - 1; i++) {
            if (!iswalpha(lexer->lookahead)) {
                if (i == 0) {
                    return false;
                }
                break;
            }
            scanned_word[i] = (char)lexer->lookahead;
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
    "public",   "private",  "protected", "internal", "abstract", "final",  "open",   "override", "lateinit",
    "vararg",   "noinline", "crossinline", "external", "suspend", "inline", "infix", "expect",   "actual",
};

// The words other than the modifiers above that start a declaration.
static const char DECLARATION_WORDS[MAX_WORDS][MAX_WORD_SIZE] = {
    "fun",  "val",    "var",   "class", "interface",  "object", "typealias", "data",
    "enum", "sealed", "inner", "value", "annotation", "const",  "operator",  "tailrec",
};

static inline bool is_identifier_start(int32_t c) { return iswalpha(c) || c == '_'; }

static bool skip_modifier_words(TSLexer *lexer, char scanned_word[MAX_WORD_SIZE]) {
    bool skipped = false;
    while (scan_words(lexer, MODIFIER_WORDS, scanned_word, NULL)) {
        skipped = true;
        memset(scanned_word, 0, MAX_WORD_SIZE);
        while (iswspace(lexer->lookahead)) {
            skip(lexer);
        }
    }
    return skipped;
}

static void skip_whitespace_and_comments(TSLexer *lexer) {
    for (;;) {
        while (iswspace(lexer->lookahead)) {
            skip(lexer);
        }
        if (lexer->lookahead != '/') {
            return;
        }
        skip(lexer);
        if (lexer->lookahead == '/') {
            while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
                skip(lexer);
            }
        } else if (lexer->lookahead == '*') {
            // Block comments nest in Kotlin.
            skip(lexer);
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
        } else {
            return;
        }
    }
}

// Skips the rest of a string or character literal or a backticked name after its opening quote.
static void skip_literal_rest(TSLexer *lexer, int32_t quote) {
    if (quote == '"' && lexer->lookahead == '"') {
        skip(lexer);
        if (lexer->lookahead != '"') {
            return;
        }
        skip(lexer);
        // A raw string has no escapes and ends at the last of three or more quotes.
        unsigned quotes = 0;
        while (!lexer->eof(lexer) && (quotes < 3 || lexer->lookahead == '"')) {
            quotes = lexer->lookahead == '"' ? quotes + 1 : 0;
            skip(lexer);
        }
        return;
    }
    while (!lexer->eof(lexer) && lexer->lookahead != quote) {
        // A backticked name has no escapes.
        if (lexer->lookahead == '\\' && quote != '`') {
            skip(lexer);
        }
        skip(lexer);
    }
    skip(lexer);
}

// Scans the rest of an accessor after `get` or `set`: either nothing more on its line, or a parameter list (empty for
// a getter, starting with the parameter's name or annotation for a setter) followed by a body or a type. The grammar
// accepts accessors after any property, including a local one, which Kotlin does not, so this is what tells a call
// such as `get("a") { … }` or an assignment such as `set = 1` on the next line from an accessor.
static bool scan_accessor_rest(TSLexer *lexer, bool setter) {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        skip(lexer);
    }
    if (lexer->lookahead != '(') {
        return lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r' || lexer->lookahead == ';' ||
               lexer->lookahead == '}' || lexer->lookahead == '/';
    }
    skip(lexer);
    skip_whitespace_and_comments(lexer);
    if (setter ? !(is_identifier_start(lexer->lookahead) || lexer->lookahead == '@' || lexer->lookahead == '`')
               : lexer->lookahead != ')') {
        return false;
    }
    unsigned depth = 1;
    while (depth > 0) {
        int32_t c = lexer->lookahead;
        if (lexer->eof(lexer)) {
            return false;
        }
        if (c == '/') {
            skip_whitespace_and_comments(lexer);
            continue;
        }
        skip(lexer);
        if (c == '(') {
            depth++;
        } else if (c == ')') {
            depth--;
        } else if (c == '"' || c == '\'' || c == '`') {
            // A parenthesis in a string or character literal (e.g. in an annotation's argument) or in a backticked name
            // is not one of the list.
            skip_literal_rest(lexer, c);
        }
    }
    skip_whitespace_and_comments(lexer);
    return lexer->lookahead == '=' || lexer->lookahead == '{' || lexer->lookahead == ':';
}

void *tree_sitter_kotlin_external_scanner_create() { return NULL; }

void tree_sitter_kotlin_external_scanner_destroy(void *payload) {}

unsigned tree_sitter_kotlin_external_scanner_serialize(void *payload, char *buffer) { return 0; }

void tree_sitter_kotlin_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

bool tree_sitter_kotlin_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    // During error recovery every token is valid, including string content and a semicolon, which never are
    // together otherwise. Scanning string content there would consume the rest of the input on each
    // recovery attempt, making recovery quadratic in the input length.
    bool error_recovery = valid_symbols[MULTILINE_STRING_CONTENT] && valid_symbols[SEMI];
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
        // Where a statement may end, `val` is valid only after a modifier that `_reserved_identifier` also reads as a
        // whole statement (`private` alone on its line). As in Kotlin, the modifier then belongs to a declaration that
        // starts on the next line, possibly with more modifiers or annotations.
        if (valid_symbols[VAL] && !error_recovery) {
            if (lexer->lookahead == '@') {
                return false;
            }
            if (iswalpha(lexer->lookahead)) {
                if (skip_modifier_words(lexer, scanned_word) ||
                    scan_words(lexer, DECLARATION_WORDS, scanned_word, NULL)) {
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
                skip_modifier_words(lexer, scanned_word);
            keywords:;
                uint8_t index = -1;
                bool res = scan_words(
                    lexer,
                    (const char[16][16]){"else", "in", "instanceof", "get", "set", "constructor", "by", "as", "where"},
                    scanned_word, &index);

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
