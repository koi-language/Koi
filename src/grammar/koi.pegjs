// ============================================================
// ZenScript Grammar - Peggy PEG
// ============================================================

{
  function buildBinaryExpression(head, tail) {
    return tail.reduce((acc, [_, op, __, expr]) => ({
      type: 'BinaryExpression',
      operator: op,
      left: acc,
      right: expr,
      location: location()
    }), head);
  }
}

// ============================================================
// Top-level program
// ============================================================

Program
  = _ decls:Declaration* _ {
      return {
        type: 'Program',
        declarations: decls.filter(d => d !== null),
        location: location()
      };
    }

Declaration
  = PackageDecl
  / ImportDecl
  / RoleDecl
  / TeamDecl
  / AgentDecl
  / SkillDecl
  / RunStatement

// ============================================================
// Package
// ============================================================

PackageDecl
  = "package"i _ name:StringLiteral _ {
      return { type: 'PackageDecl', name, location: location() };
    }

// ============================================================
// Import (TypeScript/JavaScript style)
// ============================================================

ImportDecl
  = "import"i _ name:StringLiteral _ {
      return { type: 'ImportDecl', what: 'module', name, location: location() };
    }

// ============================================================
// Role
// ============================================================

RoleDecl
  = "role"i _ name:Identifier _ "{" _ caps:RoleCapabilities _ "}" _ {
      return { type: 'RoleDecl', name, capabilities: caps, location: location() };
    }

RoleCapabilities
  = head:RoleCapability tail:(_ "," _ RoleCapability)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

RoleCapability
  = "can"i _ name:Identifier {
      return { type: 'Capability', name, location: location() };
    }

// ============================================================
// Team
// ============================================================

TeamDecl
  = "Team"i _ name:Identifier _ override:TeamOverride? _ "{" _ members:TeamMembers _ "}" _ {
      return { type: 'TeamDecl', name, override, members, location: location() };
    }

TeamOverride
  = "override"i _ "{" _ overrides:TeamMembers _ "}" {
      return overrides;
    }

TeamMembers
  = head:TeamMember tail:(_ TeamMember)* {
      return [head, ...tail.map(t => t[1])];
    }

TeamMember
  = name:Identifier _ "=" _ value:(MCPAddress / StringLiteral / Identifier) _ {
      return { name, value, location: location() };
    }

// ============================================================
// Agent
// ============================================================

AgentDecl
  = "Agent"i _ name:Identifier _ ":" _ role:Identifier _ "{" _ body:AgentBody _ "}" _ {
      return { type: 'AgentDecl', name, role, body, location: location() };
    }

AgentBody
  = items:(AgentBodyItem)* {
      // Flatten any arrays (for comma-separated uses statements)
      return items.flat();
    }

AgentBodyItem
  = UsesSkill
  / UsesTeam
  / LLMConfig
  / EventHandler
  / StateDecl
  / PlaybookDecl
  / ResilienceDecl
  / ExportFunction

UsesSkill
  = "uses"i _ "skill"i _ names:IdentifierList _ {
      return names.map(name => ({ type: 'UsesSkill', skill: name, location: location() }));
    }

UsesTeam
  = "uses"i _ "team"i _ names:IdentifierList _ {
      return names.map(name => ({ type: 'UsesTeam', team: name, location: location() }));
    }

// Comma-separated list of identifiers
IdentifierList
  = first:Identifier rest:(_ "," _ Identifier)* {
      return [first, ...rest.map(r => r[3])];
    }

LLMConfig
  = "llm"i _ "default"i _ "=" _ config:ObjectLiteral _ {
      return { type: 'LLMConfig', config, location: location() };
    }

EventHandler
  = "on"i _ event:HandlerName _ "(" _ params:Parameters? _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: 'EventHandler', event, params: params || [], body, location: location() };
    }

HandlerName
  = name:$([a-zA-Z_][a-zA-Z0-9_]*) &{
      const reserved = ['run', 'package', 'import', 'skill', 'role', 'can', 'Team', 'Agent', 'Skill',
                        'uses', 'llm', 'default', 'on', 'state', 'playbook', 'resilience',
                        'export', 'async', 'function', 'var', 'const', 'let', 'if', 'else', 'for', 'of', 'in', 'while',
                        'return', 'await', 'send', 'timeout', 'use', 'override', 'affordance',
                        'true', 'false', 'null'];
      if (reserved.includes(name.toLowerCase())) {
        error(`'${name}' is a reserved keyword and cannot be used as a handler name.\n` +
              `Use a different name like 'start', 'execute', 'process', or '${name}Handler'.`);
      }
      return true;
    } {
      return { type: 'Identifier', name, location: location() };
    }

StateDecl
  = "state"i _ "{" _ fields:StateFields _ "}" _ {
      return { type: 'StateDecl', fields, location: location() };
    }

StateFields
  = head:StateField tail:(_ StateField)* {
      return [head, ...tail.map(t => t[1])];
    }

StateField
  = name:Identifier _ ":" _ type:TypeAnnotation _ init:("=" _ Expression)? _ {
      return {
        name,
        type,
        init: init ? init[2] : null,
        location: location()
      };
    }
  / name:Identifier _ "=" _ init:Expression _ {
      return {
        name,
        type: null,
        init,
        location: location()
      };
    }

PlaybookDecl
  = "playbook"i _ name:StringLiteral _ content:StringLiteral _ {
      return { type: 'PlaybookDecl', name, content, location: location() };
    }

ResilienceDecl
  = "resilience"i _ name:StringLiteral _ "{" _ props:ResilienceProps _ "}" _ {
      return { type: 'ResilienceDecl', name, properties: props, location: location() };
    }

ResilienceProps
  = head:ResilienceProp tail:(_ ResilienceProp)* {
      return [head, ...tail.map(t => t[1])];
    }

ResilienceProp
  = name:Identifier _ "=" _ value:(Literal / Identifier) _ {
      return { name, value, location: location() };
    }

// ============================================================
// Skill
// ============================================================

SkillDecl
  = "Skill"i _ name:Identifier _ "{" _ body:SkillBody _ "}" _ {
      // Extract affordance, functions, agents, teams, and constants from body
      const affordance = body.find(item => item.type === 'AffordanceDecl');
      const functions = body.filter(item => item.type === 'ExportFunction');
      const agents = body.filter(item => item.type === 'AgentDecl');
      const teams = body.filter(item => item.type === 'TeamDecl');
      const constants = body.filter(item => item.type === 'SkillConstDeclaration');
      const variables = body.filter(item => item.type === 'SkillVariableDeclaration');

      return {
        type: 'SkillDecl',
        name,
        affordance: affordance ? affordance.content.value : null,
        functions,
        agents,
        teams,
        constants,
        variables,
        location: location()
      };
    }

SkillBody
  = items:(SkillBodyItem)* {
      return items;
    }

SkillBodyItem
  = AffordanceDecl
  / AgentDecl
  / TeamDecl
  / ExportFunction
  / SkillConstDeclaration
  / SkillVariableDeclaration

// Skill-level const/let declarations (TypeScript-style with optional type annotation)
// Supports: const x = ..., const { a, b } = ..., const [a, b] = ...
SkillConstDeclaration
  = "const"i _ pattern:DestructuringPattern _ "=" _ value:Expression _ {
      return {
        type: 'SkillConstDeclaration',
        pattern,
        destructuring: true,
        value,
        location: location()
      };
    }
  / "const"i _ name:Identifier _ typeAnnotation:(":" _ TypeAnnotation)? _ "=" _ value:Expression _ {
      return {
        type: 'SkillConstDeclaration',
        name,
        value,
        typeAnnotation: typeAnnotation ? typeAnnotation[2] : null,
        location: location()
      };
    }
  / "let"i _ pattern:DestructuringPattern _ "=" _ value:Expression _ {
      return {
        type: 'SkillConstDeclaration',
        pattern,
        destructuring: true,
        value,
        location: location()
      };
    }
  / "let"i _ name:Identifier _ typeAnnotation:(":" _ TypeAnnotation)? _ "=" _ value:Expression _ {
      return {
        type: 'SkillConstDeclaration',
        name,
        value,
        typeAnnotation: typeAnnotation ? typeAnnotation[2] : null,
        location: location()
      };
    }

// Destructuring patterns for const/let declarations
DestructuringPattern
  = ObjectDestructuringPattern
  / ArrayDestructuringPattern

ObjectDestructuringPattern
  = "{" _ props:DestructuringPropertyList? _ "}" {
      return { type: 'ObjectPattern', properties: props || [], location: location() };
    }

ArrayDestructuringPattern
  = "[" _ elements:DestructuringElementList? _ "]" {
      return { type: 'ArrayPattern', elements: elements || [], location: location() };
    }

DestructuringPropertyList
  = head:DestructuringProperty tail:(_ "," _ DestructuringProperty)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

DestructuringProperty
  = key:Identifier _ ":" _ value:Identifier {
      return { type: 'Property', key, value, shorthand: false, location: location() };
    }
  / key:Identifier {
      return { type: 'Property', key, value: key, shorthand: true, location: location() };
    }

DestructuringElementList
  = head:DestructuringElement tail:(_ "," _ DestructuringElement)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

DestructuringElement
  = Identifier
  / DestructuringPattern

// Skill-level var declarations
SkillVariableDeclaration
  = "var"i _ name:Identifier _ ":" _ varType:TypeAnnotation _ init:("=" _ Expression)? _ {
      return {
        type: 'SkillVariableDeclaration',
        name,
        varType,
        init: init ? init[2] : null,
        location: location()
      };
    }
  / "var"i _ name:Identifier _ "=" _ value:Expression _ {
      return { type: 'SkillVariableDeclaration', name, value, location: location() };
    }

AffordanceDecl
  = "affordance"i _ content:StringLiteral _ {
      return { type: 'AffordanceDecl', content, location: location() };
    }

ExportFunction
  = isExport:("export"i _)? isAsync:("async"i _)? "function"i _ name:Identifier _ "(" _ params:FunctionParameters? _ ")" _ returnType:(":" _ TypeAnnotation)? _ "{" body:FunctionBody "}" _ {
      return {
        type: 'ExportFunction',
        name,
        isExport: !!isExport,
        isAsync: !!isAsync,
        params: params || [],
        returnType: returnType ? returnType[2] : null,
        body: { code: body },
        location: location()
      };
    }

// TypeScript-style function parameters (with optional types and default values)
FunctionParameters
  = head:FunctionParameter tail:(_ "," _ FunctionParameter)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

FunctionParameter
  = name:Identifier optional:"?"? _ typeAnnotation:(":" _ TypeAnnotation)? _ defaultValue:("=" _ Expression)? {
      return {
        name,
        optional: !!optional,
        type: typeAnnotation ? typeAnnotation[2] : null,
        defaultValue: defaultValue ? defaultValue[2] : null,
        location: location()
      };
    }

// Capture function body as raw text (handles nested braces)
FunctionBody
  = body:$((FunctionBodyChar)*) {
      return body.trim();
    }

FunctionBodyChar
  = "{" FunctionBody "}"  // Nested braces
  / [^{}]                 // Any character except braces

// ============================================================
// Statements
// ============================================================

Statement
  = PlaybookStatement
  / VariableDeclaration
  / ConstDeclaration
  / IfStatement
  / ForStatement
  / WhileStatement
  / ReturnStatement
  / SendStatement
  / UsePlaybookStatement
  / ExpressionStatement

PlaybookStatement
  = "playbook"i _ content:StringLiteral _ {
      return { type: 'PlaybookStatement', content, location: location() };
    }

VariableDeclaration
  = "var"i _ name:Identifier _ ":" _ type:TypeAnnotation _ init:("=" _ Expression)? _ {
      return {
        type: 'VariableDeclaration',
        name,
        varType: type,
        init: init ? init[2] : null,
        location: location()
      };
    }

ConstDeclaration
  = "const"i _ name:Identifier _ "=" _ value:Expression _ {
      return { type: 'ConstDeclaration', name, value, location: location() };
    }
  / "let"i _ name:Identifier _ "=" _ value:Expression _ {
      return { type: 'ConstDeclaration', name, value, location: location() };
    }

IfStatement
  = "if"i _ cond:Expression _ "{" _ then:Statement* _ "}" _ alt:ElseClause? _ {
      return { type: 'IfStatement', condition: cond, then, else: alt, location: location() };
    }

ElseClause
  = "else"i _ "{" _ body:Statement* _ "}" {
      return body;
    }

ForStatement
  = "for"i _ "(" _ decl:("const"i / "let"i / "var"i) _ id:Identifier _ "of"i _ expr:Expression _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: 'ForOfStatement', declaration: decl, id, expression: expr, body, location: location() };
    }
  / "for"i _ "(" _ decl:("const"i / "let"i / "var"i) _ id:Identifier _ "in"i _ expr:Expression _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: 'ForInStatement', declaration: decl, id, expression: expr, body, location: location() };
    }
  / "for"i _ "(" _ init:ForInit? _ ";" _ cond:Expression? _ ";" _ update:Expression? _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: 'ForStatement', init, condition: cond, update, body, location: location() };
    }

ForInit
  = VariableDeclaration
  / ConstDeclaration
  / Expression

WhileStatement
  = "while"i _ cond:Expression _ "{" _ body:Statement* _ "}" _ {
      return { type: 'WhileStatement', condition: cond, body, location: location() };
    }

ReturnStatement
  = "return"i _ value:Expression? _ {
      return { type: 'ReturnStatement', value, location: location() };
    }

SendStatement
  = "await"i _ "send"i _ target:SendTarget _ args:CallArguments _ timeout:TimeoutClause? _ {
      return { type: 'SendStatement', target, arguments: args, timeout, location: location() };
    }

SendTarget
  = base:PostfixExpression filters:SendFilter* {
      return { base, filters, location: location() };
    }

SendFilter
  = _ "." "event"i "(" _ name:StringLiteral _ ")" {
      return { type: 'EventFilter', event: name, location: location() };
    }
  / _ "." "role"i "(" _ role:Identifier _ ")" {
      return { type: 'RoleFilter', role, location: location() };
    }
  / _ "." "any"i "(" _ ")" {
      return { type: 'SelectionFilter', mode: 'any', location: location() };
    }
  / _ "." "all"i "(" _ ")" {
      return { type: 'SelectionFilter', mode: 'all', location: location() };
    }

TimeoutClause
  = "timeout"i _ value:Integer unit:TimeUnit {
      return { value, unit, location: location() };
    }

TimeUnit
  = "ms"i / "s"i / "m"i / "h"i

UsePlaybookStatement
  = "use"i _ "playbook"i _ name:(Identifier / StringLiteral) _ {
      return { type: 'UsePlaybookStatement', name, location: location() };
    }

ExpressionStatement
  = expr:Expression _ {
      return { type: 'ExpressionStatement', expression: expr, location: location() };
    }

// ============================================================
// Expressions
// ============================================================

Expression
  = AssignmentExpression
  / LogicalOrExpression

AssignmentExpression
  = left:AssignmentTarget _ op:("=" / "+=" / "-=" / "*=" / "/=" / "%=") _ right:Expression {
      return { type: 'AssignmentExpression', operator: op, left, right, location: location() };
    }

// Valid targets for assignment: identifiers and member expressions (like this.state.x or arr[0])
AssignmentTarget
  = base:PrimaryExpression chain:ChainElement+ {
      return chain.reduce((obj, element) => {
        if (element.type === 'member') {
          return { type: 'MemberExpression', object: obj, property: element.property, computed: element.computed, location: location() };
        }
        return obj;
      }, base);
    }
  / Identifier

LogicalOrExpression
  = head:LogicalAndExpression tail:(_ ("||") _ LogicalAndExpression)* {
      return buildBinaryExpression(head, tail);
    }

LogicalAndExpression
  = head:EqualityExpression tail:(_ ("&&") _ EqualityExpression)* {
      return buildBinaryExpression(head, tail);
    }

EqualityExpression
  = head:RelationalExpression tail:(_ ("===" / "!==" / "==" / "!=") _ RelationalExpression)* {
      return buildBinaryExpression(head, tail);
    }

RelationalExpression
  = head:AdditiveExpression tail:(_ ("<=" / ">=" / "<" / ">") _ AdditiveExpression)* {
      return buildBinaryExpression(head, tail);
    }

AdditiveExpression
  = head:MultiplicativeExpression tail:(_ ("+" / "-") _ MultiplicativeExpression)* {
      return buildBinaryExpression(head, tail);
    }

MultiplicativeExpression
  = head:UnaryExpression tail:(_ ("*" / "/" / "%") _ UnaryExpression)* {
      return buildBinaryExpression(head, tail);
    }

UnaryExpression
  = AwaitExpression
  / NewExpression
  / op:("!" / "-") _ expr:UnaryExpression {
      return { type: 'UnaryExpression', operator: op, argument: expr, location: location() };
    }
  / PostfixExpression

NewExpression
  = "new" _ callee:MemberOrPrimary args:CallArguments {
      return { type: 'NewExpression', callee, arguments: args, location: location() };
    }

// Member or Primary for new expressions (no call arguments included)
MemberOrPrimary
  = base:PrimaryExpression props:PropertyAccessOnly+ {
      return props.reduce((obj, acc) => ({
        type: 'MemberExpression',
        object: obj,
        property: acc.property,
        computed: acc.computed,
        location: location()
      }), base);
    }
  / PrimaryExpression

PropertyAccessOnly
  = "." _ prop:PropertyIdentifier {
      return { property: prop, computed: false };
    }
  / "[" _ prop:Expression _ "]" {
      return { property: prop, computed: true };
    }

PostfixExpression
  = ChainedExpression
  / PrimaryExpression

// Chained expressions support method calls and property access in any order
// Examples: obj.method(), obj.prop.method(), obj.method().prop, obj.method().method2()
ChainedExpression
  = base:PrimaryExpression chain:ChainElement+ {
      return chain.reduce((obj, element) => {
        if (element.type === 'call') {
          return { type: 'CallExpression', callee: obj, arguments: element.args, optional: element.optional, location: location() };
        } else if (element.type === 'member') {
          return { type: 'MemberExpression', object: obj, property: element.property, computed: element.computed, optional: element.optional, location: location() };
        }
        return obj;
      }, base);
    }

ChainElement
  = "?." _ prop:PropertyIdentifier {
      return { type: 'member', property: prop, computed: false, optional: true };
    }
  / "." _ prop:PropertyIdentifier {
      return { type: 'member', property: prop, computed: false, optional: false };
    }
  / "?.[" _ prop:Expression _ "]" {
      return { type: 'member', property: prop, computed: true, optional: true };
    }
  / "[" _ prop:Expression _ "]" {
      return { type: 'member', property: prop, computed: true, optional: false };
    }
  / "?.(" _ args:ArgumentList? _ ")" {
      return { type: 'call', args: args || [], optional: true };
    }
  / args:CallArguments {
      return { type: 'call', args, optional: false };
    }

// PropertyIdentifier allows reserved words (like .default, .class, etc.)
PropertyIdentifier
  = name:$([a-zA-Z_][a-zA-Z0-9_]*) {
      return { type: 'Identifier', name, location: location() };
    }

CallArguments
  = "(" _ args:ArgumentList? _ ")" {
      return args || [];
    }

ArgumentList
  = head:Expression tail:(_ "," _ Expression)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

// Keep old MemberExpression for backwards compatibility (not used directly anymore)
MemberExpression
  = object:PrimaryExpression props:PropertyAccess+ {
      return props.reduce((obj, acc) => ({
        type: 'MemberExpression',
        object: obj,
        property: acc.property,
        computed: acc.computed,
        location: location()
      }), object);
    }

PropertyAccess
  = "." prop:PropertyIdentifier {
      return { property: prop, computed: false };
    }
  / "[" _ prop:Expression _ "]" {
      return { property: prop, computed: true };
    }

PrimaryExpression
  = ArrowFunction
  / Identifier
  / Literal
  / ObjectLiteral
  / ArrayLiteral
  / "(" _ expr:Expression _ ")" { return expr; }

AwaitExpression
  = "await"i _ "send"i _ target:SendTarget _ args:CallArguments _ timeout:TimeoutClause? {
      return { type: 'AwaitExpression', target, arguments: args, timeout, location: location() };
    }
  / "await"i _ expr:PostfixExpression {
      return { type: 'AwaitExpression', argument: expr, location: location() };
    }

ArrowFunction
  = isAsync:("async"i _)? "(" _ params:ParameterList? _ ")" _ "=>" _ body:ArrowBody {
      return { type: 'ArrowFunction', isAsync: !!isAsync, params: params || [], body, location: location() };
    }
  / isAsync:("async"i _)? param:Identifier _ "=>" _ body:ArrowBody {
      return { type: 'ArrowFunction', isAsync: !!isAsync, params: [param], body, location: location() };
    }

ParameterList
  = head:Identifier tail:(_ "," _ Identifier)* {
      return [head, ...tail.map(t => t[3])];
    }

ArrowBody
  = "{" _ stmts:Statement* _ "}" {
      return { type: 'BlockStatement', statements: stmts, location: location() };
    }
  / expr:Expression {
      return expr;
    }

// ============================================================
// Literals
// ============================================================

Literal
  = MCPAddress
  / TemplateLiteral
  / RegexLiteral
  / StringLiteral
  / NumberLiteral
  / BooleanLiteral
  / NullLiteral

// Regular expression literals: /pattern/flags
RegexLiteral
  = "/" pattern:$RegexBody "/" flags:$[gimsuvy]* {
      return { type: 'RegexLiteral', pattern, flags, location: location() };
    }

RegexBody
  = RegexChar+

RegexChar
  = !("/" / "\\") char:. { return char; }
  / "\\" char:. { return "\\" + char; }  // Escaped characters

MCPAddress
  = "mcp://" server:$([a-zA-Z0-9.-]+) "/" path:$([a-zA-Z0-9/_.-]*) {
      return {
        type: 'MCPAddress',
        server,
        path,
        address: `mcp://${server}/${path}`,
        location: location()
      };
    }

TemplateLiteral
  = "`" parts:TemplatePart* "`" {
      return { type: 'TemplateLiteral', parts, location: location() };
    }

TemplatePart
  = "${" _ expr:Expression _ "}" {
      return { type: 'TemplateExpression', expression: expr, location: location() };
    }
  / chars:TemplateChar+ {
      return { type: 'TemplateString', value: chars.join(''), location: location() };
    }

TemplateChar
  = !("${" / "`" / "\\") char:. { return char; }
  / "\\" seq:EscapeSequence { return seq; }

StringLiteral
  = "\"\"\"" content:$((!("\"\"\"") .)* ) "\"\"\"" {
      return { type: 'StringLiteral', value: content.trim(), multiline: true, location: location() };
    }
  / "\"" chars:DoubleStringChar* "\"" {
      return { type: 'StringLiteral', value: chars.join(''), multiline: false, location: location() };
    }
  / "'" chars:SingleStringChar* "'" {
      return { type: 'StringLiteral', value: chars.join(''), multiline: false, location: location() };
    }

DoubleStringChar
  = !("\"" / "\\") char:. { return char; }
  / "\\" seq:EscapeSequence { return seq; }

SingleStringChar
  = !("'" / "\\") char:. { return char; }
  / "\\" seq:EscapeSequence { return seq; }

EscapeSequence
  = "n" { return "\n"; }
  / "t" { return "\t"; }
  / "r" { return "\r"; }
  / "\\" { return "\\"; }
  / "\"" { return "\""; }
  / "'" { return "'"; }

NumberLiteral
  = value:Float {
      return { type: 'NumberLiteral', value: parseFloat(value), location: location() };
    }
  / value:Integer {
      return { type: 'NumberLiteral', value: parseInt(value, 10), location: location() };
    }

Float
  = Integer "." Digit+ { return text(); }

Integer
  = Digit+ { return text(); }

BooleanLiteral
  = "true"i {
      return { type: 'BooleanLiteral', value: true, location: location() };
    }
  / "false"i {
      return { type: 'BooleanLiteral', value: false, location: location() };
    }

NullLiteral
  = "null"i {
      return { type: 'NullLiteral', value: null, location: location() };
    }

ObjectLiteral
  = "{" _ props:PropertyList? _ "}" {
      return { type: 'ObjectLiteral', properties: props || [], location: location() };
    }

PropertyList
  = head:Property tail:(_ "," _ Property)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

Property
  = "..." _ expr:Expression {
      return { type: 'SpreadProperty', argument: expr, location: location() };
    }
  / key:(Identifier / StringLiteral / PropertyKey) _ ":" _ value:Expression {
      return { key, value, location: location() };
    }

PropertyKey
  = name:$("$"? [a-zA-Z_][a-zA-Z0-9_]*) {
      return { name, type: 'Identifier', location: location() };
    }

ArrayLiteral
  = "[" _ elements:ArgumentList? _ "]" {
      return { type: 'ArrayLiteral', elements: elements || [], location: location() };
    }

// ============================================================
// Types
// ============================================================

// TypeScript-style type annotations (with union support)
TypeAnnotation
  = head:TypeAnnotationTerm tail:(_ "|" _ TypeAnnotationTerm)* {
      if (tail.length === 0) return head;
      return {
        type: 'TypeAnnotation',
        name: 'Union',
        types: [head, ...tail.map(t => t[3])],
        location: location()
      };
    }

// Single type term (with optional array suffix)
TypeAnnotationTerm
  = base:TypeAnnotationBase arraySuffix:("[]")* {
      let result = base;
      for (const _ of arraySuffix) {
        result = { type: 'TypeAnnotation', name: 'Array', inner: result, location: location() };
      }
      return result;
    }

// Base type (primitive, generic, object type, or identifier)
// Note: Longer keywords must come before shorter ones (boolean before Bool)
TypeAnnotationBase
  = "boolean"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'boolean', location: location() }; }
  / "number"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'number', location: location() }; }
  / "string"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'string', location: location() }; }
  / "void"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'void', location: location() }; }
  / "any"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'any', location: location() }; }
  / "null"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'null', location: location() }; }
  / "undefined"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'undefined', location: location() }; }
  / "Int"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'Int', location: location() }; }
  / "String"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'String', location: location() }; }
  / "Bool"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'Bool', location: location() }; }
  / "Json"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'Json', location: location() }; }
  / "Promise"i _ "<" _ inner:TypeAnnotation _ ">" {
      return { type: 'TypeAnnotation', name: 'Promise', inner, location: location() };
    }
  / name:Identifier _ "<" _ inner:TypeAnnotation _ ">" {
      return { type: 'TypeAnnotation', name: name.name, inner, location: location() };
    }
  / ObjectTypeAnnotation
  / "(" _ inner:TypeAnnotation _ ")" { return inner; }
  / name:Identifier {
      return { type: 'TypeAnnotation', name: name.name, location: location() };
    }

// Inline object type: { field: type, field2?: type2, ... }
ObjectTypeAnnotation
  = "{" _ fields:ObjectTypeFieldList? _ "}" {
      return {
        type: 'TypeAnnotation',
        name: 'ObjectType',
        fields: fields || [],
        location: location()
      };
    }

ObjectTypeFieldList
  = head:ObjectTypeField tail:(_ ("," / ";") _ ObjectTypeField)* _ ("," / ";")? {
      return [head, ...tail.map(t => t[3])];
    }

ObjectTypeField
  = name:Identifier optional:"?"? _ ":" _ fieldType:TypeAnnotation {
      return {
        name: name.name,
        type: fieldType,
        optional: !!optional,
        location: location()
      };
    }

// ============================================================
// Parameters
// ============================================================

Parameters
  = head:Parameter tail:(_ "," _ Parameter)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

Parameter
  = name:Identifier _ ":" _ type:TypeAnnotation {
      return { name, type, location: location() };
    }

// ============================================================
// Run Statement
// ============================================================

RunStatement
  = "run"i _ target:MemberExpression args:CallArguments _ {
      return { type: 'RunStatement', target, arguments: args, location: location() };
    }

// ============================================================
// Identifiers
// ============================================================

Identifier
  = !ReservedWord name:$([a-zA-Z_][a-zA-Z0-9_]*) {
      return { type: 'Identifier', name, location: location() };
    }

ReservedWord
  = ("package" / "import" / "skill" / "role" / "can" / "Team" / "Agent" / "Skill" /
     "uses" / "llm" / "default" / "on" / "state" / "playbook" / "resilience" /
     "export" / "async" / "function" / "var" / "const" / "let" / "if" / "else" / "for" / "of" / "in" / "while" /
     "return" / "await" / "send" / "timeout" / "use" / "run" /
     "override" / "affordance" / "true" / "false" / "null") !IdentifierPart

IdentifierPart
  = [a-zA-Z0-9_]

Digit
  = [0-9]

// ============================================================
// Whitespace and Comments
// ============================================================

_
  = (WhiteSpace / LineTerminator / Comment)*

WhiteSpace
  = [ \t\r\n]

LineTerminator
  = [\n\r]

Comment
  = "//" (!LineTerminator .)*
  / "/*" (!"*/" .)* "*/"
