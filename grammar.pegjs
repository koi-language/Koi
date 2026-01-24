// AgentLang Grammar v2
// Agent-Oriented Programming with Skills, Teams, and Async Communication

Program
  = _ items:(TopLevelStatement _)* {
      return {
        type: 'Program',
        declarations: items.map(i => i[0]),
        loc: location()
      };
    }

TopLevelStatement
  = PackageDecl
  / SkillDeclaration
  / RoleDeclaration
  / AgentDeclaration
  / TeamDeclaration
  / RunStatement
  / Comment

// ============================================================
// PACKAGE - Module/namespace declaration
// ============================================================

PackageDecl
  = "package" _ packageName:StringLiteral {
      return {
        type: 'PackageDecl',
        name: packageName,
        loc: location()
      };
    }

// ============================================================
// SKILLS - Packages of capabilities with internal agents
// ============================================================

SkillDeclaration
  = "Skill" _ name:Identifier _ "{" _ body:SkillBody _ "}" {
      return {
        type: 'SkillDecl',
        name,
        affordance: body.affordance,
        agents: body.agents,
        teams: body.teams,
        functions: body.functions,
        loc: location()
      };
    }

SkillBody
  = items:(SkillBodyItem _)* {
      const affordance = items.find(i => i[0]?.type === 'Affordance')?.[0]?.content || null;
      const agents = items.filter(i => i[0]?.type === 'AgentDecl').map(i => i[0]);
      const teams = items.filter(i => i[0]?.type === 'TeamDecl').map(i => i[0]);
      const functions = items.filter(i => i[0]?.type === 'FunctionDecl').map(i => i[0]);
      return { affordance, agents, teams, functions };
    }

SkillBodyItem
  = Affordance
  / AgentDeclaration
  / TeamDeclaration
  / FunctionDeclaration

Affordance
  = "affordance" _ content:TripleQuotedString {
      return {
        type: 'Affordance',
        content,
        loc: location()
      };
    }

// ============================================================
// AGENTS - With roles, LLM config, event handlers
// ============================================================

AgentDeclaration
  = "Agent" _ name:Identifier _ role:RoleInheritance? _ "{" _ bodyItems:AgentBody? _ "}" {
      return {
        type: 'AgentDecl',
        name,
        role: role || null,
        body: bodyItems?.body || [],
        llmConfig: bodyItems?.llmConfig || null,
        skills: bodyItems?.skills || [],
        properties: bodyItems?.properties || [],
        eventHandlers: bodyItems?.eventHandlers || [],
        loc: location()
      };
    }

RoleInheritance
  = ":" _ role:Identifier {
      return role;
    }

AgentBody
  = items:(AgentBodyItem _)* {
      const body = items.map(i => i[0]);
      const llmConfig = items.find(i => i[0]?.type === 'LLMConfig')?.[0] || null;
      const skillsAssignment = items.find(i => i[0]?.type === 'SkillsAssignment')?.[0];
      const skills = skillsAssignment?.skills || [];
      const properties = items.filter(i => i[0]?.type === 'Property').map(i => i[0]);
      const eventHandlers = items.filter(i => i[0]?.type === 'EventHandler').map(i => i[0]);

      // Convert skills array to UsesSkill format expected by transpiler
      const usesSkills = skills.map(skill => ({
        type: 'UsesSkill',
        skill: skill
      }));

      // Add peers property if found
      const peersProperty = properties.find(p => p.key.name === 'peers');
      const bodyWithUsesSkill = [...body.filter(i => i.type !== 'SkillsAssignment'), ...usesSkills];
      if (peersProperty) {
        bodyWithUsesSkill.push({ type: 'PeersDecl', team: peersProperty.value });
      }

      return { body: bodyWithUsesSkill, llmConfig, skills, properties, eventHandlers };
    }

AgentBodyItem
  = LLMConfig
  / SkillsAssignment
  / PeersAssignment
  / EventHandler
  / Property

PeersAssignment
  = "peers" _ "=" _ "Team" _ team:Identifier {
      return {
        type: 'Property',
        key: { type: 'Identifier', name: 'peers' },
        value: team,
        loc: location()
      };
    }

LLMConfig
  = "llm" _ name:Identifier _ "=" _ config:ObjectLiteral {
      return {
        type: 'LLMConfig',
        name,
        config,
        loc: location()
      };
    }

SkillsAssignment
  = "uses" _ "Skill" _ skill:Identifier {
      return {
        type: 'SkillsAssignment',
        skills: [skill],
        loc: location()
      };
    }
  / "skills" _ "=" _ skills:ArrayExpression {
      return {
        type: 'SkillsAssignment',
        skills,
        loc: location()
      };
    }

EventHandler
  = "on" _ name:Identifier _ "(" _ params:TypedParameterList? _ ")" _ "{" _ body:EventHandlerBody _ "}" {
      return {
        type: 'EventHandler',
        event: name,
        name: name.name,
        params: params || [],
        body,
        loc: location()
      };
    }

EventHandlerBody
  = _ playbook:Playbook _ {
      return [{
        type: 'PlaybookStatement',
        content: { value: playbook },
        loc: location()
      }];
    }
  / code:CodeBlock {
      return [{
        type: 'RawCodeBlock',
        code: code.code,
        loc: location()
      }];
    }

EventHandlerCodeStatements
  = first:EventHandlerCodeStatement rest:(_ EventHandlerCodeStatement)* {
      return [first, ...rest.map(r => r[1])];
    }

EventHandlerCodeStatement
  = _ stmt:CodeStatement _ {
      return stmt;
    }

Playbook
  = "playbook" _ content:TripleQuotedString {
      return {
        type: 'Playbook',
        content,
        loc: location()
      };
    }

// ============================================================
// TEAMS - Composition of agents
// ============================================================

TeamDeclaration
  = "Team" _ name:Identifier _ "{" _ members:TeamMemberList? _ "}" {
      return {
        type: 'TeamDecl',
        name,
        members: members || [],
        loc: location()
      };
    }

TeamMemberList
  = first:TeamMember rest:(_ TeamMember)* {
      return [first, ...rest.map(r => r[1])];
    }

TeamMember
  = name:Identifier _ "=" _ value:TeamMemberValue {
      return {
        type: 'TeamMember',
        name,
        value,
        loc: location()
      };
    }

TeamMemberValue
  = MCPAddress
  / agent:Identifier {
      return { type: 'AgentReference', agent };
    }

MCPAddress
  = "mcp://" path:[a-zA-Z0-9._\-/]+ {
      return {
        type: 'MCPAddress',
        address: 'mcp://' + path.join('')
      };
    }

// ============================================================
// RUN STATEMENT - Execute agent method
// ============================================================

RunStatement
  = "run" _ target:MemberExpression _ args:CallArguments {
      return {
        type: 'RunStatement',
        target,
        arguments: args,
        loc: location()
      };
    }
  / "run" _ target:Identifier _ args:CallArguments {
      return {
        type: 'RunStatement',
        target,
        arguments: args,
        loc: location()
      };
    }

// ============================================================
// ROLES - Base roles for agents
// ============================================================

RoleDeclaration
  = "role" _ name:Identifier _ "{" _ capabilities:CapabilityList _ "}" {
      return {
        type: 'RoleDecl',
        name,
        capabilities: capabilities || [],
        loc: location()
      };
    }

CapabilityList
  = first:Capability rest:(_ "," _ Capability)* {
      return [first, ...rest.map(r => r[3])];
    }

Capability
  = "can" _ name:Identifier {
      return {
        type: 'Capability',
        name,
        loc: location()
      };
    }

// ============================================================
// FUNCTIONS - TypeScript/JavaScript code blocks
// ============================================================

FunctionDeclaration
  = export_:("export" _)? async_:("async" _)? "function" _ name:Identifier _ "(" _ params:TypedParameterList? _ ")" _ returnType:TypeAnnotation? _ "{" _ body:CodeBlock _ "}" {
      return {
        type: 'FunctionDecl',
        name,
        params: params || [],
        returnType,
        body,
        isExport: !!export_,
        isAsync: !!async_,
        loc: location()
      };
    }

TypedParameterList
  = first:TypedParameter rest:(_ "," _ TypedParameter)* {
      return [first, ...rest.map(r => r[3])];
    }

TypedParameter
  = name:Identifier type:TypeAnnotation? {
      return {
        type: 'Parameter',
        name,
        typeAnnotation: type,
        loc: location()
      };
    }

TypeAnnotation
  = ":" _ typeName:TypeExpression {
      return typeName;
    }

TypeExpression
  = "any" { return { type: 'AnyType' }; }
  / "string" { return { type: 'StringType' }; }
  / "number" { return { type: 'NumberType' }; }
  / "boolean" { return { type: 'BooleanType' }; }
  / "Json" { return { type: 'JsonType' }; }
  / "Promise" _ "<" _ inner:TypeExpression _ ">" {
      return { type: 'PromiseType', inner };
    }
  / name:Identifier {
      return { type: 'CustomType', name: name.name };
    }

// ============================================================
// CODE - TypeScript/JavaScript code (simplified)
// ============================================================

CodeBlock
  = chars:CodeChar* {
      return {
        type: 'CodeBlock',
        code: chars.join(''),
        loc: location()
      };
    }

CodeChar
  = [^{}]
  / "{" chars:CodeChar* "}" {
      return '{' + chars.join('') + '}';
    }

CodeStatement
  = ReturnStatement
  / AwaitSendStatement
  / VariableDeclaration
  / AssignmentStatement
  / ExpressionStatement

ReturnStatement
  = "return" _ expr:Expression {
      return {
        type: 'ReturnStatement',
        argument: expr,
        loc: location()
      };
    }

AwaitSendStatement
  = "await" _ send:SendExpression {
      return {
        type: 'AwaitStatement',
        expression: send,
        loc: location()
      };
    }

SendExpression
  = "send" _ target:Identifier _ "." _ "event" _ "(" _ event:StringLiteral _ ")" _ chain:SendChain _ args:CallArguments _ timeout:TimeoutClause? {
      return {
        type: 'SendExpression',
        target,
        event,
        chain,
        args,
        timeout,
        loc: location()
      };
    }

SendChain
  = items:("." _ Identifier _ "(" _ ArgumentList? _ ")")* {
      return items.map(item => ({
        method: item[2].name,
        args: item[6] || []
      }));
    }

TimeoutClause
  = "timeout" _ duration:Duration {
      return duration;
    }

Duration
  = value:[0-9]+ unit:("s" / "ms" / "m") {
      return {
        type: 'Duration',
        value: parseInt(value.join('')),
        unit: unit
      };
    }

VariableDeclaration
  = kind:("const" / "let" / "var") _ name:Identifier _ "=" _ value:Expression {
      return {
        type: 'VariableDeclaration',
        kind,
        name,
        value,
        loc: location()
      };
    }

AssignmentStatement
  = target:Identifier _ "=" _ value:Expression {
      return {
        type: 'AssignmentStatement',
        target,
        value,
        loc: location()
      };
    }

ExpressionStatement
  = expr:Expression {
      return {
        type: 'ExpressionStatement',
        expression: expr,
        loc: location()
      };
    }

// ============================================================
// EXPRESSIONS
// ============================================================

Expression
  = AwaitExpression
  / BinaryExpression
  / MemberExpression
  / CallExpression
  / ObjectLiteral
  / ArrayExpression
  / PrimaryExpression

AwaitExpression
  = "await" _ send:SendExpression {
      return {
        type: 'AwaitExpression',
        expression: send,
        loc: location()
      };
    }

BinaryExpression
  = left:PrimaryExpression _ op:BinaryOperator _ right:Expression {
      return {
        type: 'BinaryExpression',
        operator: op,
        left,
        right,
        loc: location()
      };
    }

BinaryOperator
  = "+" / "-" / "*" / "/" / "==" / "!=" / "<" / ">" / "<=" / ">=" / "??" / "&&" / "||"

MemberExpression
  = object:Identifier _ "." _ property:Identifier rest:(_ "." _ Identifier)* {
      let expr = {
        type: 'MemberExpression',
        object,
        property,
        loc: location()
      };
      for (const r of rest) {
        expr = {
          type: 'MemberExpression',
          object: expr,
          property: r[3],
          loc: location()
        };
      }
      return expr;
    }

CallExpression
  = callee:Identifier _ args:CallArguments {
      return {
        type: 'CallExpression',
        callee,
        arguments: args,
        loc: location()
      };
    }

CallArguments
  = "(" _ args:ArgumentList? _ ")" {
      return args || [];
    }

ArgumentList
  = first:Expression rest:(_ "," _ Expression)* {
      return [first, ...rest.map(r => r[3])];
    }

ObjectLiteral
  = "{" _ properties:PropertyList? _ "}" {
      return {
        type: 'ObjectLiteral',
        properties: properties || [],
        loc: location()
      };
    }

PropertyList
  = first:Property rest:(_ ","? _ Property)* {
      return [first, ...rest.map(r => r[3])];
    }

Property
  = key:PropertyKey _ ":" _ value:Expression {
      return {
        type: 'Property',
        key,
        value,
        loc: location()
      };
    }

PropertyKey
  = Identifier
  / StringLiteral

ArrayExpression
  = "[" _ elements:ArgumentList? _ "]" {
      return {
        type: 'ArrayExpression',
        elements: elements || [],
        loc: location()
      };
    }

PrimaryExpression
  = TripleQuotedString { return { type: 'StringLiteral', value: text().slice(3, -3), loc: location() }; }
  / StringLiteral
  / NumberLiteral
  / BooleanLiteral
  / NullLiteral
  / Identifier
  / "(" _ expr:Expression _ ")" { return expr; }

// ============================================================
// LITERALS
// ============================================================

TripleQuotedString
  = '"""' chars:TripleQuotedChar* '"""' {
      return chars.join('');
    }

TripleQuotedChar
  = !'"""' char:. { return char; }

StringLiteral
  = '"' chars:DoubleQuotedChar* '"' {
      return {
        type: 'StringLiteral',
        value: chars.join(''),
        loc: location()
      };
    }
  / "'" chars:SingleQuotedChar* "'" {
      return {
        type: 'StringLiteral',
        value: chars.join(''),
        loc: location()
      };
    }

DoubleQuotedChar
  = "\\" char:. { return '\\' + char; }
  / [^"]

SingleQuotedChar
  = "\\" char:. { return '\\' + char; }
  / [^']

NumberLiteral
  = [0-9]+ ("." [0-9]+)? {
      return {
        type: 'NumberLiteral',
        value: parseFloat(text()),
        loc: location()
      };
    }

BooleanLiteral
  = ("true" / "false") {
      return {
        type: 'BooleanLiteral',
        value: text() === 'true',
        loc: location()
      };
    }

NullLiteral
  = "null" {
      return {
        type: 'NullLiteral',
        value: null,
        loc: location()
      };
    }

Identifier
  = !ReservedWord [a-zA-Z_][a-zA-Z0-9_]* {
      return {
        type: 'Identifier',
        name: text(),
        loc: location()
      };
    }

ReservedWord
  = ("Skill" / "Agent" / "Team" / "run" / "can" / "affordance" / "playbook" / "on" / "llm" / "skills" / "uses" / "send" / "await" / "timeout" / "export" / "async" / "function" / "const" / "let" / "var" / "return" / "if" / "else" / "for" / "while" / "package") ![a-zA-Z0-9_]

// ============================================================
// WHITESPACE AND COMMENTS
// ============================================================

_ "whitespace"
  = ([ \t\n\r] / Comment)*

Comment
  = "//" [^\n]* ("\n" / EOF)
  / "/*" (!"*/" .)* "*/"

EOF
  = !.
