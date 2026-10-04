/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  SPREAD: 1,
  LOGICAL_OR: 2,
  LOGICAL_AND: 3,
  EQUAL: 4,
  RELATIONAL: 5,
  IN: 6,
  ELVIS: 7,
  INFIX: 8,
  RANGE: 9,
  ADD: 10,
  MULTIPLY: 11,
  AS: 12,
  CALL: 13,
  UNARY: 14,
};

// oxlint-disable-next-line unicorn/prefer-module -- This package is CommonJS, so tree-sitter loads grammar.js as CommonJS.
module.exports = grammar({
  name: 'kotlin',

  conflicts: ($) => [
    [$.class_declaration],
    [$.property_declaration],
    [$.if_expression, $.parenthesized_expression],
    [$.class_body, $.enum_class_body],

    [$.binary_expression, $.call_expression],
    [$.binary_expression, $.in_expression, $.call_expression],
    [$.binary_expression, $.infix_expression, $.call_expression],
    [$.binary_expression, $.range_expression, $.call_expression],

    [$.user_type],
    [$._simple_user_type, $.primary_expression],
    [$.type, $._receiver_type],

    [$.modifiers, $.annotated_lambda],
    [$.modifiers, $.annotated_expression],

    [$.delegation_specifier, $.type_modifiers],
    [$.annotated_expression, $.type_modifiers],
    [$.annotated_expression, $.type_modifiers, $.when_subject],
    [$.annotated_expression, $.type_modifiers, $.modifiers],
    [$.variable_declaration, $._loop_prefix, $.modifiers, $.type_modifiers, $.annotated_expression],
    [$._loop_prefix, $.annotated_expression],
    [$._loop_prefix, $.modifiers, $.type_modifiers, $.annotated_expression],
    [$._loop_prefix, $.labeled_expression],
    [$._loop_prefix, $.type_modifiers, $.annotated_expression],
    [$.parameter_modifiers, $.type_modifiers],
    [$.function_modifier, $.type_modifiers],
    [$.function_modifier, $._reserved_identifier],
    [$.function_modifier, $.type_modifiers, $._reserved_identifier],
    [$.type_modifiers, $._reserved_identifier],
    [$.variable_declaration, $.type_modifiers],
    [$.variable_declaration, $.type_modifiers, $.modifiers, $.annotated_expression],
    [$.variable_declaration, $.type_modifiers, $.annotated_expression],
    [$.variable_declaration],

    [$.function_value_parameters, $.function_type_parameters],
    [$.parenthesized_type, $.function_type_parameters],
    [$.multi_variable_declaration, $.function_type_parameters],

    [$.class_modifier, $._reserved_identifier],
    [$.platform_modifier, $._reserved_identifier],
    [$.property_modifier, $._reserved_identifier],
    [$.inheritance_modifier, $._reserved_identifier],
    [$.visibility_modifier, $._reserved_identifier],
    [$.member_modifier, $._reserved_identifier],

    [$.context_parameters, $._reserved_identifier],
    [$._modifier_context_parameters, $._reserved_identifier],
    [$.context_parameters, $._modifier_context_parameters, $._reserved_identifier],
    [$._context_entry, $._modifier_context_parameters],
    [$._modifier_context_parameters],
    [$.secondary_constructor, $._reserved_identifier],
    [$.enum_entry, $.modifiers],
    [$.qualified_identifier],
    [$._spaced_annotation_invocation, $._unescaped_annotation],
    [$.nullable_type],
    [$.non_nullable_type],
    [$.function_type],
    [$._receiver_type],
  ],

  extras: ($) => [/\s/, $.line_comment, $.block_comment],

  externals: ($) => [
    $._semi,
    $._class_member_semi,
    // Unlike properties, these declarations can end before another member on the same line.
    $._same_line_member_end,
    $.block_comment,
    // also lexed by the scanner, since the generated lexer stops at a NUL character
    $.line_comment,
    $._not_is,
    $._in,
    $._q_dot,
    $._multiline_string_content,
    $._multi_dollar_string_start,
    $._multi_dollar_multiline_string_start,
    $._multi_dollar_string_content,
    $._multi_dollar_interpolation_start,
    $._multi_dollar_string_end,
    // used to check if a preceding annoation should not have an automatic _semi inserted
    'constructor',
    'get',
    'set',
    // used to check if we can parse a comment
    '$',
    // used to check if a modifier alone on its line belongs to a declaration on the next line
    'val',
    // empty: a newline before an annotation or parenthesis can end a statement or continue a declaration
    $._primary_constructor_position,
    // empty: it ends a delegation expression in a class header before `{` (see `explicit_delegation`)
    $._delegation_end,
    // the `)` that ends a call's arguments (see `value_arguments`)
    $._arguments_end,
    // empty: they tell the scanner when a statement list or the member list of a class body opens in braces, and when
    // either closes (see `frames` in the scanner)
    $._open_statements,
    $._open_members,
    $._close_braces,
    $._top_level_statement_end,
    // empty: it ends a context list of types among modifiers, except directly in a statement list (see `modifiers`)
    $._context_end,
    // a hard keyword other than `this` right after the `$` of a string template (see `_template_name`)
    $._keyword_reference,
    // never scanned: see `_template_name`
    $._keyword_reference_end,
    'where',
    $._separated_member_start,
    $._unseparated_member_start,
  ],

  inline: ($) => [$._statements, $._identifier, $._control_structure_body],

  precedences: ($) => [
    [$.block, $.lambda_literal],
    [$.function_type, $.nullable_type],
    [$.function_type, $.non_nullable_type],
  ],

  supertypes: ($) => [
    $.class_member_declaration,
    $.declaration,
    $.expression,
    $.primary_expression,
    $.type,
    $.statement,
  ],

  word: ($) => $.identifier,

  // Kotlin's hard keywords are never names. `true`, `false`, `null`, and `typeof` are hard keywords too, but this
  // grammar has no tokens for them, so they still parse as names.
  reserved: {
    global: () => [
      'as',
      'break',
      'class',
      'continue',
      'do',
      'else',
      'for',
      'fun',
      'if',
      'in',
      'interface',
      'is',
      'object',
      'package',
      'return',
      'super',
      'this',
      'throw',
      'try',
      'typealias',
      'val',
      'var',
      'when',
      'while',
    ],
  },

  rules: {
    source_file: ($) =>
      seq(
        optional($.shebang),
        repeat($.file_annotation),
        optional($.package_header),
        repeat($.import),
        // The scanner clears its brace frames after each top-level statement, so that a brace that error recovery
        // consumed affects no later statement.
        repeat(seq($.statement, $._statement_semi, $._top_level_statement_end))
      ),

    _statement_semi: ($) => choice($._semi, $._primary_constructor_position),
    _member_semi: ($) => choice($._class_member_semi, $._primary_constructor_position),

    file_annotation: ($) =>
      seq(
        '@',
        'file',
        ':',
        choice(seq('[', repeat1($._unescaped_annotation), ']'), $._unescaped_annotation),
        $._statement_semi
      ),

    package_header: ($) => seq('package', $.qualified_identifier, optional(';')),

    import: ($) =>
      seq('import', $.qualified_identifier, optional(choice(seq('.', '*'), seq('as', $.identifier))), optional(';')),

    declaration: ($) =>
      choice($.class_declaration, $.object_declaration, $.function_declaration, $.property_declaration, $.type_alias),

    class_declaration: ($) =>
      seq(
        optional($.modifiers),
        choice('class', seq(optional(seq('fun', optional($._unseparated_member_start))), 'interface')),
        optional($._unseparated_member_start),
        field('name', $.identifier),
        optional($.type_parameters),
        optional($.primary_constructor),
        optional(seq(':', $.delegation_specifiers)),
        optional($.type_constraints),
        optional(choice($.class_body, $.enum_class_body))
      ),

    object_declaration: ($) =>
      prec.right(
        seq(
          optional($.modifiers),
          'object',
          optional($._unseparated_member_start),
          field('name', $.identifier),
          optional(seq(':', $.delegation_specifiers)),
          optional($.class_body)
        )
      ),

    property_declaration: ($) =>
      seq(
        optional($.modifiers),
        choice('val', 'var'),
        optional($._separated_member_start),
        optional($.type_parameters),
        optional(seq($._receiver_type, optional('.'))),
        choice($.variable_declaration, $.multi_variable_declaration),
        optional($.type_constraints),
        optional(choice(seq('=', $.expression), $.property_delegate)),
        optional(';'),
        optional(choice(seq($.getter, optional($.setter)), seq($.setter, optional($.getter))))
      ),

    type_alias: ($) =>
      prec.right(
        seq(
          optional($.modifiers),
          'typealias',
          optional($._separated_member_start),
          field('type', $.identifier),
          optional($.type_parameters),
          '=',
          $.type
        )
      ),

    companion_object: ($) =>
      seq(
        optional($.modifiers),
        'companion',
        'object',
        optional($._unseparated_member_start),
        optional(field('name', $.identifier)),
        optional(seq(':', $.delegation_specifiers)),
        optional($.class_body)
      ),

    anonymous_initializer: ($) => seq('init', optional($._unseparated_member_start), $.block),

    secondary_constructor: ($) =>
      seq(
        optional($.modifiers),
        'constructor',
        optional($._unseparated_member_start),
        $.function_value_parameters,
        optional(seq(':', $.constructor_delegation_call)),
        optional($.block)
      ),

    constructor_delegation_call: ($) => seq(choice('this', 'super'), $.value_arguments),

    type_parameters: ($) => seq('<', commaSep1($.type_parameter), optional(','), '>'),

    type_parameter: ($) => seq(optional($.type_parameter_modifiers), $.identifier, optional(seq(':', $.type))),

    primary_constructor: ($) =>
      seq(
        optional(seq(optional($.modifiers), 'constructor')),
        optional($._primary_constructor_position),
        $.class_parameters
      ),

    class_parameters: ($) => seq('(', optionalCommaSep1($.class_parameter), ')'),

    class_parameter: ($) =>
      seq(
        optional($.modifiers),
        optional(choice('val', 'var')),
        $._identifier,
        ':',
        $.type,
        optional(seq('=', $.expression))
      ),

    type_constraints: ($) => prec.right(seq('where', commaSep1($.type_constraint))),

    type_constraint: ($) => prec.right(seq($.identifier, ':', $.type)),

    constructor_invocation: ($) => seq($.type, $.value_arguments),

    function_declaration: ($) =>
      prec.right(
        1,
        seq(
          optional($.modifiers),
          'fun',
          optional($._unseparated_member_start),
          optional($.type_parameters),
          optional(seq($._receiver_type, optional('.'))),
          field('name', $._identifier),
          $.function_value_parameters,
          optional(seq(':', $.type)),
          optional($.type_constraints),
          optional($.function_body)
        )
      ),

    function_value_parameters: ($) =>
      seq(
        '(',
        optionalCommaSep1(seq(optional($.parameter_modifiers), $.parameter, optional(seq('=', $.expression)))),
        ')'
      ),

    parameter: ($) => seq($._identifier, ':', $.type),

    delegation_specifiers: ($) => commaSep1($.delegation_specifier),

    delegation_specifier: ($) =>
      prec.right(seq(repeat($.annotation), choice($.constructor_invocation, $.explicit_delegation, $.type))),

    variable_declaration: ($) => prec(1, seq(repeat($.annotation), $._identifier, optional(seq(':', $.type)))),

    multi_variable_declaration: ($) => seq('(', optionalCommaSep1($.variable_declaration), ')'),

    property_delegate: ($) => seq('by', $.expression),

    // As in Kotlin, a `{` after the delegation expression starts the class body, never a trailing lambda, also after the
    // last operand of an operator (`B by a ?: b { … }`): the scanner ends the expression before it.
    explicit_delegation: ($) => seq($.type, 'by', $.expression, optional($._delegation_end)),

    getter: ($) =>
      prec.right(
        seq(optional($.modifiers), 'get', optional(seq('(', ')', optional(seq(':', $.type)), $.function_body)))
      ),

    setter: ($) =>
      prec.right(
        seq(
          optional($.modifiers),
          'set',
          optional(
            seq(
              '(',
              optional($.parameter_modifiers),
              $.identifier,
              optional(seq(':', $.type)),
              optional(seq('=', $.expression)),
              optional(','),
              ')',
              optional(seq(':', $.type)),
              $.function_body
            )
          )
        )
      ),

    function_body: ($) => choice($.block, seq('=', $.expression)),

    block: ($) => seq('{', $._open_statements, optional($._statements), '}', $._close_braces),

    for_statement: ($) =>
      prec.right(
        seq(
          optional($._loop_prefix),
          'for',
          '(',
          repeat($.annotation),
          choice($.variable_declaration, $.multi_variable_declaration),
          'in',
          $.expression,
          ')',
          optional(field('body', $._control_structure_body))
        )
      ),

    while_statement: ($) =>
      prec.right(
        seq(
          optional($._loop_prefix),
          'while',
          '(',
          field('condition', $.expression),
          ')',
          optional(choice(field('body', $._control_structure_body), ';'))
        )
      ),

    do_while_statement: ($) =>
      prec.right(
        seq(
          optional($._loop_prefix),
          'do',
          optional(choice(field('body', $._control_structure_body), ';')),
          'while',
          '(',
          field('condition', $.expression),
          ')'
        )
      ),

    _loop_prefix: ($) => prec.dynamic(1, repeat1(choice($.annotation, $.label))),

    class_body: ($) => seq('{', $._open_members, repeat($._class_member_with_separator), '}', $._close_braces),

    _class_member_with_separator: ($) =>
      seq($.class_member_declaration, optional($._same_line_member_end), $._member_semi),

    class_member_declaration: ($) =>
      choice($.declaration, $.companion_object, $.anonymous_initializer, $.secondary_constructor),

    _annotations: ($) => repeat1($.annotation),

    enum_class_body: ($) =>
      seq(
        '{',
        $._open_members,
        optionalCommaSep1($.enum_entry),
        optional(seq(';', repeat($._class_member_with_separator))),
        '}',
        $._close_braces
      ),

    // Only annotations can modify an enum entry, and with the full modifier list a `context` after an annotation would
    // start a context parameter list instead of naming the entry.
    enum_entry: ($) =>
      seq(
        optional(alias($._annotations, $.modifiers)),
        $._identifier,
        optional($.value_arguments),
        optional($.class_body)
      ),

    value_arguments: ($) => valueArguments($, '('),

    value_argument: ($) => seq(optional(seq($._identifier, '=')), optional('*'), $.expression),

    _statements: ($) => seq($.statement, repeat(seq($._statement_semi, $.statement)), optional($._statement_semi)),

    statement: ($) =>
      choice($.declaration, $.assignment, $.for_statement, $.while_statement, $.do_while_statement, $.expression),

    // Modifiers before a declaration may also read as an annotated expression statement (`@A (b)`) or, for modifier
    // keywords that `_reserved_identifier` accepts, as names, and both readings parse, so the one in which they modify
    // the declaration takes dynamic precedence, as in Kotlin.
    modifiers: ($) =>
      prec.dynamic(
        1,
        prec.right(
          repeat1(
            choice(
              seq(optional($._primary_constructor_position), $.annotation),
              $.class_modifier,
              $.member_modifier,
              $.function_modifier,
              $.property_modifier,
              $.visibility_modifier,
              $.inheritance_modifier,
              $.parameter_modifier,
              $.platform_modifier,
              alias($._modifier_context_parameters, $.context_parameters)
            )
          )
        )
      ),

    class_modifier: () => choice('enum', 'sealed', 'annotation', 'data', 'inner', 'value'),

    function_modifier: () => prec.right(choice('tailrec', 'operator', 'infix', 'inline', 'external', 'suspend')),

    property_modifier: () => 'const',

    visibility_modifier: () => choice('public', 'private', 'protected', 'internal'),

    inheritance_modifier: () => choice('abstract', 'final', 'open'),

    member_modifier: () => choice('override', 'lateinit'),

    parameter_modifiers: ($) => repeat1(choice($.annotation, $.parameter_modifier)),

    parameter_modifier: () => choice('vararg', 'noinline', 'crossinline'),

    reification_modifier: () => 'reified',

    platform_modifier: () => choice('expect', 'actual'),

    type_modifiers: ($) => prec.right(repeat1(choice($.annotation, 'suspend'))),

    annotation: ($) =>
      choice(
        seq('@', optional($.use_site_target), $._unescaped_annotation),
        seq('@', optional($.use_site_target), '[', repeat1($._unescaped_annotation), ']')
      ),

    use_site_target: () =>
      seq(choice('field', 'property', 'get', 'set', 'receiver', 'param', 'setparam', 'delegate'), ':'),

    // As in Kotlin, a `(` right after an annotation's name always starts its arguments; lexing it as a separate immediate
    // token keeps an annotated parenthesized expression from being read there. After whitespace, Kotlin's reading
    // depends on the context, so both readings remain.
    _unescaped_annotation: ($) =>
      choice(
        alias($._spaced_annotation_invocation, $.constructor_invocation),
        alias($._annotation_invocation, $.constructor_invocation),
        $.type
      ),

    _spaced_annotation_invocation: ($) => seq($.type, optional($._primary_constructor_position), $.value_arguments),

    _annotation_invocation: ($) => seq($.type, alias($._annotation_arguments, $.value_arguments)),

    _annotation_arguments: ($) => valueArguments($, alias(token.immediate('('), '(')),

    type: ($) =>
      choice($.user_type, $.nullable_type, $.function_type, $.non_nullable_type, $.parenthesized_type, 'dynamic'),

    user_type: ($) => seq(optional($.type_modifiers), sep1($._simple_user_type, '.')),

    _simple_user_type: ($) => prec.right(seq($._identifier, optional($.type_arguments))),

    nullable_type: ($) => seq(optional($.type_modifiers), $.type, '?'),

    non_nullable_type: ($) =>
      prec.right(seq(optional($.type_modifiers), $.type, '&', optional($.type_modifiers), $.type)),

    _receiver_type: ($) =>
      seq(optional($.type_modifiers), choice($.user_type, 'dynamic', $.parenthesized_type, $.nullable_type)),

    // `a<B>(c)` also reads as comparisons (`a < B > (c)`); like Kotlin's parser, prefer the type arguments.
    type_arguments: ($) => prec.dynamic(1, seq('<', commaSep1($.type_projection), optional(','), '>')),

    type_projection: ($) => choice(seq(repeat($.variance_modifier), $.type), '*'),

    function_type: ($) =>
      seq(
        optional($.type_modifiers),
        optional($.context_parameters),
        optional(seq($._receiver_type, '.')),
        $.function_type_parameters,
        '->',
        $.type
      ),

    // Context parameters (`context(scope: Scope)`, Kotlin 2.2) and the older context receivers (`context(Scope)`).
    context_parameters: ($) => seq('context', '(', commaSep1($._context_entry), optional(','), ')'),

    _context_entry: ($) => choice(seq(optional($.parameter_modifiers), $.parameter), $.type),

    // Directly in a statement list, Kotlin reads `context(…)` with only types as a call, e.g. before a local declaration
    // on the next line, so the scanner ends such a list among modifiers only elsewhere. A list with a named parameter
    // cannot be a call.
    _modifier_context_parameters: ($) =>
      seq(
        'context',
        '(',
        choice(
          seq(commaSep1($.type), optional(','), ')', $._context_end),
          seq(
            repeat(seq($.type, ',')),
            seq(optional($.parameter_modifiers), $.parameter),
            repeat(seq(',', $._context_entry)),
            optional(','),
            ')'
          )
        )
      ),

    function_type_parameters: ($) => seq('(', optionalCommaSep1(choice($.parameter, $.type)), ')'),

    parenthesized_type: ($) => seq('(', $.type, ')'),

    assignment: ($) =>
      seq(
        field('left', $.expression),
        field('operator', choice('=', '+=', '-=', '*=', '/=', '%=')),
        field('right', $.expression)
      ),

    expression: ($) =>
      choice(
        $.primary_expression,
        $.index_expression,
        $.return_expression,
        $.throw_expression,
        $.continue_expression,
        $.break_expression
      ),

    primary_expression: ($) =>
      choice(
        $._identifier,
        $.string_literal,
        $.multiline_string_literal,
        $.character_literal,
        $.number_literal,
        $.float_literal,
        $.object_literal,
        $.collection_literal,
        $.navigation_expression,
        $.binary_expression,
        $.unary_expression,
        $.annotated_expression,
        $.labeled_expression,
        $.call_expression,
        $.in_expression,
        $.is_expression,
        $.as_expression,
        $.spread_expression,
        $.infix_expression,
        $.range_expression,
        $.if_expression,
        $.parenthesized_expression,
        $.this_expression,
        $.super_expression,
        $.when_expression,
        $.try_expression,
        $.callable_reference,
        $.lambda_literal,
        $.anonymous_function
      ),

    unary_expression: ($) =>
      prec.left(
        PREC.UNARY,
        choice(
          seq(field('operator', choice('++', '--', '+', '-', '!')), field('argument', $.expression)),
          seq(field('argument', $.expression), field('operator', choice('++', '--', '!!')))
        )
      ),

    annotated_expression: ($) => seq($.annotation, $.expression),

    labeled_expression: ($) => seq($.label, $.expression),

    binary_expression: ($) => {
      const table = [
        ['+', PREC.ADD],
        ['-', PREC.ADD],
        ['*', PREC.MULTIPLY],
        ['/', PREC.MULTIPLY],
        ['%', PREC.MULTIPLY],
        ['||', PREC.LOGICAL_OR],
        ['&&', PREC.LOGICAL_AND],
        ['!=', PREC.EQUAL],
        ['!==', PREC.EQUAL],
        ['==', PREC.EQUAL],
        ['===', PREC.EQUAL],
        ['>', PREC.RELATIONAL],
        ['>=', PREC.RELATIONAL],
        ['<=', PREC.RELATIONAL],
        ['<', PREC.RELATIONAL],
        ['?:', PREC.ELVIS],
      ];

      return choice(
        ...table.map(([operator, precedence]) => {
          return prec.left(
            precedence,
            seq(
              field('left', $.expression),
              // @ts-ignore
              field('operator', operator),
              field('right', $.expression)
            )
          );
        })
      );
    },

    in_expression: ($) =>
      prec.left(PREC.IN, seq(field('left', $.expression), choice('in', '!in'), field('right', $.expression))),

    is_expression: ($) =>
      prec.left(
        PREC.IN,
        seq(field('left', $.expression), choice('is', alias($._not_is, '!is')), field('right', $.type))
      ),

    as_expression: ($) =>
      prec.left(PREC.AS, seq(field('left', $.expression), choice('as', 'as?'), field('right', $.type))),

    spread_expression: ($) => prec(PREC.SPREAD, seq('*', $.expression)),

    range_expression: ($) => prec.left(PREC.RANGE, seq($.expression, choice('..', '..<'), $.expression)),

    infix_expression: ($) => prec.left(PREC.INFIX, seq($.expression, $.identifier, $.expression)),

    // Right-associative so that a trailing lambda after arguments belongs to the same call (`f(x) { … }`), as in
    // Kotlin, instead of calling the result of `f(x)`.
    call_expression: ($) =>
      prec.right(
        PREC.CALL,
        seq(
          $.expression,
          optional($.type_arguments),
          choice($.value_arguments, seq(optional($.value_arguments), $.annotated_lambda))
        )
      ),

    annotated_lambda: ($) => seq(repeat($.annotation), optional($.label), $.lambda_literal),

    lambda_literal: ($) =>
      seq(
        '{',
        $._open_statements,
        optional(seq(optional($.lambda_parameters), '->')),
        optionalSep1($.statement, $._statement_semi),
        '}',
        $._close_braces
      ),

    lambda_parameters: ($) => seq(commaSep1($._lambda_parameter), optional(',')),

    _lambda_parameter: ($) => choice($.variable_declaration, $.multi_variable_declaration),

    anonymous_function: ($) =>
      prec.right(
        seq(
          optional($.context_parameters),
          'fun',
          optional(seq($.type, '.')),
          $.function_value_parameters,
          optional(seq(':', $.type)),
          optional($.type_constraints),
          $.function_body
        )
      ),

    index_expression: ($) => prec(PREC.CALL, seq($.expression, '[', commaSep1($.expression), optional(','), ']')),

    this_expression: ($) => seq(choice('this', seq('this@', $.identifier))),

    super_expression: ($) =>
      prec.right(
        choice(
          'super',
          seq('super', '<', $.type, '>'),
          seq('super@', $.identifier),
          seq('super', '<', $.type, '>', token.immediate('@'), $.identifier)
        )
      ),

    if_expression: ($) =>
      prec.right(
        seq(
          'if',
          '(',
          field('condition', $.expression),
          ')',
          choice(
            field('consequence', $._control_structure_body),
            ';',
            seq(
              optional(field('consequence', $._control_structure_body)),
              optional(';'),
              'else',
              choice(field('alternative', $._control_structure_body), ';')
            )
          )
        )
      ),

    // Unlike Kotlin's grammar, this excludes declarations, which the compiler rejects here anyway: allowing them
    // lets declarations nest in every expression context and exceeds tree-sitter's limit of 65535 parse states.
    _control_structure_body: ($) =>
      choice($.block, $.expression, $.assignment, $.for_statement, $.while_statement, $.do_while_statement),

    parenthesized_expression: ($) => seq('(', $.expression, ')'),

    collection_literal: ($) => seq('[', optionalCommaSep1($.expression), ']'),

    when_expression: ($) =>
      seq('when', optional($.when_subject), '{', $._open_statements, repeat($.when_entry), '}', $._close_braces),

    when_subject: ($) =>
      seq('(', optional(seq(repeat($.annotation), 'val', $.variable_declaration, '=')), $.expression, ')'),

    when_entry: ($) =>
      seq(
        choice(seq(commaSep1(field('condition', $._when_condition)), optional(',')), 'else'),
        optional(seq('if', field('guard', $.expression))),
        '->',
        field('body', choice($.block, $.statement)),
        optional($._statement_semi)
      ),

    _when_condition: ($) => choice($.expression, $.range_test, $.type_test),

    range_test: ($) => seq(choice(alias($._in, 'in'), '!in'), $.expression),

    type_test: ($) => seq(choice('is', alias($._not_is, '!is')), $.type),

    try_expression: ($) =>
      seq('try', $.block, choice(seq(repeat1($.catch_block), optional($.finally_block)), $.finally_block)),

    catch_block: ($) => seq('catch', '(', repeat($.annotation), $.identifier, ':', $.type, optional(','), ')', $.block),

    finally_block: ($) => seq('finally', $.block),

    return_expression: ($) =>
      prec.right(seq(choice('return', seq('return@', field('label', $.identifier))), optional($.expression))),

    throw_expression: ($) => seq('throw', $.expression),

    continue_expression: ($) => choice('continue', seq('continue@', field('label', $.identifier))),

    break_expression: ($) => choice('break', seq('break@', field('label', $.identifier))),

    callable_reference: ($) => seq(optional($._receiver_type), '::', choice($.identifier, 'class')),

    navigation_expression: ($) =>
      prec(
        PREC.CALL,
        choice(
          seq($.expression, choice('.', alias($._q_dot, '?.')), $.identifier),
          seq($.expression, '::', choice($.identifier, 'class'))
        )
      ),

    object_literal: ($) => seq('object', optional(seq(':', $.delegation_specifiers)), $.class_body),

    string_literal: ($) =>
      choice(
        seq(
          '"',
          repeat(
            choice(
              alias(
                choice(token.immediate(prec(2, seq('\\', /[^bnrt'"\\$]/))), token.immediate(prec(1, /[^"\\$]+/)), '$'),
                $.string_content
              ),
              $.escape_sequence,
              $.interpolation
            )
          ),
          '"'
        ),
        seq(
          $._multi_dollar_string_start,
          repeat(
            choice(
              alias($._multi_dollar_string_content, $.string_content),
              $.escape_sequence,
              alias($._multi_dollar_interpolation, $.interpolation)
            )
          ),
          $._multi_dollar_string_end
        )
      ),

    multiline_string_literal: ($) =>
      choice(
        seq('"""', repeat(choice(alias($._multiline_string_content, $.string_content), $.interpolation)), '"""'),
        seq(
          $._multi_dollar_multiline_string_start,
          repeat(
            choice(
              alias($._multi_dollar_string_content, $.string_content),
              alias($._multi_dollar_interpolation, $.interpolation)
            )
          ),
          $._multi_dollar_string_end
        )
      ),

    interpolation: ($) => choice(seq('$', $._template_name), seq('${', $.expression, '}')),

    // Immediate so that it outranks the string content that would otherwise absorb the name. As in Kotlin, `$this`
    // refers to `this`: with the same token precedence as the name pattern, the string token wins a match of equal
    // length (without its `prec(2)`, `$this` lexes as a name again), while a longer name such as `$thisX` still wins.
    _template_name: ($) =>
      choice(
        alias(token.immediate(prec(2, /[\p{L}_][\p{L}_\p{Nd}]*/u)), $.identifier),
        alias(token.immediate(prec(2, 'this')), $.this_expression),
        // As in Kotlin, another hard keyword after `$` is an error: the scanner lexes it, and the grammar then expects
        // `_keyword_reference_end`, which is never scanned. The first alias keeps a name required in `interpolation`; the
        // second makes the end visible when error recovery inserts it as missing, which a hidden token would not be.
        seq(alias($._keyword_reference, $.identifier), alias($._keyword_reference_end, 'keyword_reference_end'))
      ),

    // In a string prefixed with n dollars (Kotlin 2.1), exactly n dollars start an interpolation; the scanner
    // returns them as one token only where they do.
    _multi_dollar_interpolation: ($) =>
      seq($._multi_dollar_interpolation_start, choice($._template_name, seq(token.immediate('{'), $.expression, '}'))),

    character_literal: ($) => seq("'", choice(token.immediate(prec(1, /[^'\\\r\n]/)), $.escape_sequence), "'"),

    escape_sequence: () => token.immediate(prec(1, seq('\\', choice(/[^xu0-7]/, /u[0-9a-fA-F]{4}/)))),

    number_literal: () => {
      const separator = '_';
      const decimal = /[0-9]+/;
      const hex = /[0-9a-fA-F]/;
      const bin = /[01]/;
      const decimalDigits = seq(repeat1(decimal), repeat(seq(separator, repeat1(decimal))));
      const hexDigits = seq(repeat1(hex), repeat(seq(separator, repeat1(hex))));
      const binDigits = seq(repeat1(bin), repeat(seq(separator, repeat1(bin))));

      return token(
        seq(choice(decimalDigits, seq(/0[xX]/, hexDigits), seq(/0[bB]/, binDigits)), optional(/([lL]|[uU][lL]?)/))
      );
    },

    float_literal: () => {
      const separator = '_';
      const decimal = /[0-9]+/;
      const exponent = /[eE][+-]?[0-9]+/;
      const decimalDigits = seq(repeat1(decimal), repeat(seq(separator, repeat1(decimal))));

      return token(
        seq(
          choice(
            seq(decimalDigits, exponent, optional(/[fF]/)),
            seq(optional(decimalDigits), '.', repeat1(decimalDigits), optional(exponent), optional(/[fF]/)),
            seq(decimalDigits, /[fF]/)
          )
        )
      );
    },

    variance_modifier: () => choice('in', 'out'),

    type_parameter_modifiers: ($) => repeat1(choice($.reification_modifier, $.variance_modifier, $.annotation)),

    qualified_identifier: ($) => seq($.identifier, repeat(seq('.', $.identifier))),

    label: () => token(/[a-zA-Z_][a-zA-Z_0-9]*@/),

    _identifier: ($) => choice($.identifier, $._reserved_identifier),

    identifier: () => token(choice(/[\p{L}_][\p{L}_\p{Nd}]*/u, /`[^\r\n`]+`/)),

    _reserved_identifier: ($) =>
      alias(
        choice(
          'abstract',
          'actual',
          'annotation',
          'const',
          'constructor',
          'data',
          'enum',
          'expect',
          'external',
          'final',
          'get',
          'infix',
          'inline',
          'inner',
          'internal',
          'lateinit',
          'open',
          'operator',
          'override',
          'private',
          'protected',
          'public',
          'sealed',
          'set',
          'suspend',
          'tailrec',
          'value',
          'context'
        ),
        $.identifier
      ),

    shebang: () => /#!.*/,

    line_comment: () => token(seq('//', /.*/)),
  },
});

/**
 * Creates a rule to match one or more of the rules separated by `separator`
 *
 * @param {RuleOrLiteral} rule
 *
 * @param {RuleOrLiteral} separator
 *
 * @returns {SeqRule}
 */
function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}

/**
 * Creates a rule to optionally match one or more of the rules separated by `separator`
 * and optionally ending with `separator`
 *
 * @param {RuleOrLiteral} rule
 *
 * @param {RuleOrLiteral} separator
 *
 * @returns {ChoiceRule}
 */
function optionalSep1(rule, separator) {
  return optional(seq(rule, repeat(seq(separator, rule)), optional(separator)));
}

/**
 * Creates a rule to match one or more of the rules separated by a comma
 *
 * @param {Rule} rule
 *
 * @returns {SeqRule}
 */
function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)));
}

/**
 * Creates a rule to optionally match one or more of the rules separated by a comma
 * and optionally ending with a comma
 *
 * @param {Rule} rule
 *
 * @returns {ChoiceRule}
 */
function optionalCommaSep1(rule) {
  return optional(seq(rule, repeat(seq(',', rule)), optional(',')));
}

/**
 * Creates the arguments of a call or an annotation. Whether a call takes a trailing lambda depends on the token after
 * its arguments, which the lookahead of the scanned `)` reaches, so an edit there makes incremental parsing reparse the
 * call instead of reusing a call without the lambda.
 *
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} open
 *
 * @returns {SeqRule}
 */
function valueArguments($, open) {
  return seq(open, optionalCommaSep1($.value_argument), alias($._arguments_end, ')'));
}
