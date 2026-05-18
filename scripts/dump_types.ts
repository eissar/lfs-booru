// dump_types.ts
import ts from 'npm:typescript@6.0.3';
import { fromFileUrl } from '@std/path/from-file-url';
import { join, relative } from '@std/path';

const projectRoot = fromFileUrl(new URL('../', import.meta.url));
const srcDir = join(projectRoot, 'src');

const entryFiles: string[] = [];

async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory) {
            await walk(fullPath);
            continue;
        }
        if (entry.isFile && fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts')) {
            entryFiles.push(fullPath);
        }
    }
}

await walk(srcDir);
entryFiles.sort();

if (entryFiles.length === 0) {
    console.error(`No .ts files found under: ${srcDir}`);
    Deno.exit(1);
}

const program = ts.createProgram(entryFiles, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
});

const checker = program.getTypeChecker();
const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
});

for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!entryFiles.includes(sourceFile.fileName)) continue;

    const declarations = sourceFile.statements
        .map((statement) => printDeclarationLikeStatement(statement, sourceFile))
        .filter((text): text is string => text !== undefined);

    if (declarations.length === 0) continue;

    console.log(`// ${relative(projectRoot, sourceFile.fileName)}`);
    for (const declaration of declarations) {
        console.log(declaration);
    }
    console.log();
}

function printDeclarationLikeStatement(statement: ts.Statement, sourceFile: ts.SourceFile): string | undefined {
    if (ts.isInterfaceDeclaration(statement)) return printNode(statement, sourceFile);
    if (ts.isTypeAliasDeclaration(statement)) return printNode(statement, sourceFile);
    if (ts.isEnumDeclaration(statement)) return printNode(statement, sourceFile);
    if (ts.isClassDeclaration(statement)) return printNode(stripClassBodies(statement), sourceFile);
    if (ts.isFunctionDeclaration(statement)) return printFunctionSignature(statement);

    return undefined;
}

function printNode(node: ts.Node, sourceFile: ts.SourceFile): string {
    return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

function printFunctionSignature(node: ts.FunctionDeclaration): string | undefined {
    if (!node.name) return undefined;

    const signature = checker.getSignatureFromDeclaration(node);
    if (!signature) return undefined;

    const exportPrefix = hasModifier(node, ts.SyntaxKind.ExportKeyword) ? 'export ' : '';
    const generatorMarker = node.asteriskToken ? '*' : '';
    const signatureText = checker.signatureToString(
        signature,
        node,
        ts.TypeFormatFlags.NoTruncation,
        ts.SignatureKind.Call,
    );

    return `${exportPrefix}function${generatorMarker} ${node.name.text}${signatureText};`;
}

function stripClassBodies(node: ts.ClassDeclaration): ts.ClassDeclaration {
    const members = node.members
        .map((member) => {
            if (ts.isConstructorDeclaration(member)) {
                return ts.factory.updateConstructorDeclaration(
                    member,
                    stripAsyncModifier(member.modifiers),
                    stripParameterInitializers(member.parameters),
                    undefined,
                );
            }
            if (ts.isMethodDeclaration(member)) {
                return ts.factory.updateMethodDeclaration(
                    member,
                    stripAsyncModifier(member.modifiers),
                    member.asteriskToken,
                    member.name,
                    member.questionToken,
                    member.typeParameters,
                    stripParameterInitializers(member.parameters),
                    member.type ?? inferredReturnTypeNode(member),
                    undefined,
                );
            }
            if (ts.isPropertyDeclaration(member)) {
                return ts.factory.updatePropertyDeclaration(
                    member,
                    member.modifiers,
                    member.name,
                    member.questionToken,
                    member.type,
                    undefined,
                );
            }
            return member;
        });

    return ts.factory.updateClassDeclaration(
        node,
        node.modifiers,
        node.name,
        node.typeParameters,
        node.heritageClauses,
        members,
    );
}

function stripAsyncModifier<T extends ts.NodeArray<ts.ModifierLike> | undefined>(modifiers: T): T {
    if (!modifiers) return modifiers;
    return ts.factory.createNodeArray(
        modifiers.filter((modifier) => modifier.kind !== ts.SyntaxKind.AsyncKeyword),
    ) as T;
}

function stripParameterInitializers(parameters: ts.NodeArray<ts.ParameterDeclaration>): ts.NodeArray<ts.ParameterDeclaration> {
    return ts.factory.createNodeArray(parameters.map((parameter) =>
        ts.factory.updateParameterDeclaration(
            parameter,
            parameter.modifiers,
            parameter.dotDotDotToken,
            parameter.name,
            parameter.questionToken,
            parameter.type,
            undefined,
        )
    ));
}

function inferredReturnTypeNode(node: ts.SignatureDeclaration): ts.TypeNode | undefined {
    const signature = checker.getSignatureFromDeclaration(node);
    if (!signature) return undefined;

    return checker.typeToTypeNode(
        checker.getReturnTypeOfSignature(signature),
        node,
        ts.NodeBuilderFlags.NoTruncation,
    );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}
