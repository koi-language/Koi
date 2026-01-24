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
      // Extract affordance, functions, agents, teams from body
      const affordance = body.find(item => item.type === 'AffordanceDecl');
      const functions = body.filter(item => item.type === 'ExportFunction');
      const agents = body.filter(item => item.type === 'AgentDecl');
      const teams = body.filter(item => item.type === 'TeamDecl');

      return {
        type: 'SkillDecl',
        name,
        affordance: affordance ? affordance.content.value : null,
        functions,
        agents,
        teams,
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

AffordanceDecl
  = "affordance"i _ content:StringLiteral _ {
      return { type: 'AffordanceDecl', content, location: location() };
    }

ExportFunction
  = "export"i _ isAsync:("async"i _)? "function"i _ name:Identifier _ "(" _ params:Parameters? _ ")" _ ":" _ returnType:TypeAnnotation _ "{" body:FunctionBody "}" _ {
      return {
        type: 'ExportFunction',
        name,
        isExport: true,
        isAsync: !!isAsync,
        params: params || [],
        returnType,
        body: { code: body },
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
  = "." "event"i "(" _ name:StringLiteral _ ")" {
      return { type: 'EventFilter', event: name, location: location() };
    }
  / "." "role"i "(" _ role:Identifier _ ")" {
      return { type: 'RoleFilter', role, location: location() };
    }
  / "." "any"i "(" _ ")" {
      return { type: 'SelectionFilter', mode: 'any', location: location() };
    }
  / "." "all"i "(" _ ")" {
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
  = left:Identifier _ op:("=" / "+=" / "-=" / "*=" / "/=" / "%=") _ right:Expression {
      return { type: 'AssignmentExpression', operator: op, left, right, location: location() };
    }

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
  = "." _ prop:Identifier {
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
          return { type: 'CallExpression', callee: obj, arguments: element.args, location: location() };
        } else if (element.type === 'member') {
          return { type: 'MemberExpression', object: obj, property: element.property, computed: element.computed, location: location() };
        }
        return obj;
      }, base);
    }

ChainElement
  = "." _ prop:Identifier {
      return { type: 'member', property: prop, computed: false };
    }
  / "[" _ prop:Expression _ "]" {
      return { type: 'member', property: prop, computed: true };
    }
  / args:CallArguments {
      return { type: 'call', args };
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
  = "." prop:Identifier {
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
  = "(" _ params:ParameterList? _ ")" _ "=>" _ body:ArrowBody {
      return { type: 'ArrowFunction', params: params || [], body, location: location() };
    }
  / param:Identifier _ "=>" _ body:ArrowBody {
      return { type: 'ArrowFunction', params: [param], body, location: location() };
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
  / StringLiteral
  / NumberLiteral
  / BooleanLiteral
  / NullLiteral

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

TypeAnnotation
  = "Int"i { return { type: 'TypeAnnotation', name: 'Int', location: location() }; }
  / "String"i { return { type: 'TypeAnnotation', name: 'String', location: location() }; }
  / "Bool"i { return { type: 'TypeAnnotation', name: 'Bool', location: location() }; }
  / "Json"i { return { type: 'TypeAnnotation', name: 'Json', location: location() }; }
  / "Promise"i _ "<" _ inner:TypeAnnotation _ ">" {
      return { type: 'TypeAnnotation', name: 'Promise', inner, location: location() };
    }
  / name:Identifier {
      return { type: 'TypeAnnotation', name: name.name, location: location() };
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
