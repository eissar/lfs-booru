// deno-lint-ignore no-import-prefix
import postcss from 'npm:postcss@8.5.15';
// deno-lint-ignore no-import-prefix
import selectorParser from 'npm:postcss-selector-parser@7.1.1';

type CliOptions = {
    cssRoots: string[];
    contentRoots: string[];
    ignoreClasses: Set<string>;
    ignoreAttributes: Set<string>;
    safelist: RegExp[];
    fail: boolean;
};

type UsageIndex = {
    classes: Set<string>;
    ids: Set<string>;
    tags: Set<string>;
    attributes: Map<string, Set<string>>;
};

type SelectorAstNode = {
    type: string;
    value?: string;
    attribute?: string;
    operator?: string;
    parent?: SelectorAstNode;
    walk?: (callback: (node: SelectorAstNode) => void | false) => void;
    each?: (callback: (node: SelectorAstNode) => void) => void;
    toString: () => string;
};

type SelectorRequirements = {
    classes: Set<string>;
    ids: Set<string>;
    tags: Set<string>;
    attributes: AttributeRequirement[];
};

type AttributeRequirement = {
    name: string;
    operator?: string;
    value?: string;
};

type UnusedSelector = {
    cssFile: string;
    line: number;
    column: number;
    selector: string;
    missing: string[];
};

const DEFAULT_OPTIONS: CliOptions = {
    cssRoots: ['static'],
    contentRoots: ['.lint-artifacts'],
    ignoreClasses: new Set(['dark-mode', 'hidden', 'light-mode']),
    ignoreAttributes: new Set(['data-theme']),
    safelist: [],
    fail: true,
};

if (import.meta.main) {
    await main();
}

async function main(): Promise<void> {
    const options = parseArgs(Deno.args);
    const cssFiles = await collectFiles(options.cssRoots, (path) => path.endsWith('.css'));
    const contentFiles = await collectFiles(options.contentRoots, (path) => /\.(html?|tsx?|jsx?)$/i.test(path));

    if (cssFiles.length === 0) {
        throw new Error(`Cannot scan CSS: no CSS files found in ${options.cssRoots.map(quote).join(', ')}`);
    }

    if (contentFiles.length === 0) {
        throw new Error(
            `Cannot scan CSS usage: no content files found in ${
                options.contentRoots.map(quote).join(', ')
            }. Run the lint artifact renderer first`,
        );
    }

    const usage = await buildUsageIndex(contentFiles);
    const unused = await findUnusedSelectors(cssFiles, usage, options);

    printSummary(cssFiles, contentFiles, unused);

    if (unused.length > 0 && options.fail) {
        Deno.exit(1);
    }
}

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        cssRoots: [...DEFAULT_OPTIONS.cssRoots],
        contentRoots: [...DEFAULT_OPTIONS.contentRoots],
        ignoreClasses: new Set(DEFAULT_OPTIONS.ignoreClasses),
        ignoreAttributes: new Set(DEFAULT_OPTIONS.ignoreAttributes),
        safelist: [...DEFAULT_OPTIONS.safelist],
        fail: DEFAULT_OPTIONS.fail,
    };

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            printHelp();
            Deno.exit(0);
        }

        if (arg === '--no-fail') {
            options.fail = false;
            continue;
        }

        const [name, value] = splitArg(arg);
        if (value === undefined) {
            throw new Error(`Cannot parse argument ${quote(arg)}: expected --name=value`);
        }

        switch (name) {
            case '--css':
                options.cssRoots = appendOrReplace(options.cssRoots, value);
                break;
            case '--content':
                options.contentRoots = appendOrReplace(options.contentRoots, value);
                break;
            case '--ignore-class':
                options.ignoreClasses.add(value);
                break;
            case '--ignore-attribute':
                options.ignoreAttributes.add(value.toLowerCase());
                break;
            case '--safelist':
                options.safelist.push(new RegExp(value));
                break;
            default:
                throw new Error(`Cannot parse argument ${quote(arg)}: unknown option ${quote(name)}`);
        }
    }

    return options;
}

function splitArg(arg: string): [string, string | undefined] {
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex === -1) {
        return [arg, undefined];
    }

    return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}

function appendOrReplace(values: string[], nextValue: string): string[] {
    if (values.length === 1 && values[0] === DEFAULT_OPTIONS.cssRoots[0] && nextValue !== DEFAULT_OPTIONS.cssRoots[0]) {
        return [nextValue];
    }

    if (
        values.length === 1 && values[0] === DEFAULT_OPTIONS.contentRoots[0] &&
        nextValue !== DEFAULT_OPTIONS.contentRoots[0]
    ) {
        return [nextValue];
    }

    return [...values, nextValue];
}

function printHelp(): void {
    console.log(`Find CSS selectors that do not match generated HTML artifacts.

Usage:
  deno run --allow-read --allow-env=CI,FORCE_COLOR,TERM scripts/find_unused_css.ts [options]

Options:
  --css=PATH                 CSS file or directory to scan. Defaults to static
  --content=PATH             HTML/TS/JS file or directory to scan. Defaults to .lint-artifacts
  --ignore-class=NAME        Treat a dynamic state class as present
  --ignore-attribute=NAME    Treat a dynamic attribute as present
  --safelist=REGEXP          Treat selectors matching the regular expression as used
  --no-fail                  Print findings but exit with status 0
`);
}

async function collectFiles(roots: string[], predicate: (path: string) => boolean): Promise<string[]> {
    const files: string[] = [];

    for (const root of roots) {
        const stat = await safeStat(root);
        if (stat === undefined) {
            continue;
        }

        if (stat.isFile) {
            if (predicate(root)) {
                files.push(root);
            }
            continue;
        }

        if (stat.isDirectory) {
            await collectFilesInDirectory(root, predicate, files);
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

async function collectFilesInDirectory(
    directory: string,
    predicate: (path: string) => boolean,
    files: string[],
): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory) {
            await collectFilesInDirectory(path, predicate, files);
            continue;
        }

        if (entry.isFile && predicate(path)) {
            files.push(path);
        }
    }
}

async function safeStat(path: string): Promise<Deno.FileInfo | undefined> {
    try {
        return await Deno.stat(path);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return undefined;
        }
        throw error;
    }
}

async function buildUsageIndex(contentFiles: string[]): Promise<UsageIndex> {
    const usage: UsageIndex = {
        classes: new Set(),
        ids: new Set(),
        tags: new Set(),
        attributes: new Map(),
    };

    for (const contentFile of contentFiles) {
        const content = await Deno.readTextFile(contentFile);
        collectHtmlUsage(content, usage);
    }

    return usage;
}

function collectHtmlUsage(content: string, usage: UsageIndex): void {
    const tagPattern = /<\s*([a-zA-Z][\w:-]*)([^<>]*)>/g;

    for (const match of content.matchAll(tagPattern)) {
        const tagName = match[1]?.toLowerCase();
        const attributes = match[2] ?? '';

        if (tagName !== undefined) {
            usage.tags.add(tagName);
        }

        collectAttributeUsage(attributes, usage);
    }
}

function collectAttributeUsage(source: string, usage: UsageIndex): void {
    const attributePattern = /([:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

    for (const match of source.matchAll(attributePattern)) {
        const name = match[1]?.toLowerCase();
        const rawValue = match[2];
        if (name === undefined) {
            continue;
        }

        const value = rawValue === undefined ? '' : unquote(rawValue);
        addAttributeValue(usage, name, value);

        if (name === 'class') {
            for (const className of splitWhitespace(value)) {
                usage.classes.add(className);
            }
        }

        if (name === 'id' && value !== '') {
            usage.ids.add(value);
        }
    }
}

function addAttributeValue(usage: UsageIndex, name: string, value: string): void {
    const values = usage.attributes.get(name) ?? new Set<string>();
    values.add(value);
    usage.attributes.set(name, values);
}

async function findUnusedSelectors(
    cssFiles: string[],
    usage: UsageIndex,
    options: CliOptions,
): Promise<UnusedSelector[]> {
    const unused: UnusedSelector[] = [];

    for (const cssFile of cssFiles) {
        const css = await Deno.readTextFile(cssFile);
        const root = postcss.parse(css, { from: cssFile });

        root.walkRules((rule) => {
            if (isInsideKeyframes(rule)) {
                return;
            }

            const selectorRoot = selectorParser().astSync(rule.selector) as SelectorAstNode;
            selectorRoot.each?.((selectorNode) => {
                const selector = selectorNode.toString().trim();
                if (selector === '' || selectorIsSafelisted(selector, options.safelist)) {
                    return;
                }

                const requirements = collectSelectorRequirements(selectorNode, options);
                const missing = missingRequirements(requirements, usage);
                if (missing.length === 0) {
                    return;
                }

                unused.push({
                    cssFile,
                    line: rule.source?.start?.line ?? 1,
                    column: rule.source?.start?.column ?? 1,
                    selector,
                    missing,
                });
            });
        });
    }

    return unused;
}

function isInsideKeyframes(rule: postcss.Rule): boolean {
    let node: postcss.Node | undefined = rule.parent;
    while (node !== undefined) {
        if (node.type === 'atrule' && /keyframes$/i.test((node as postcss.AtRule).name)) {
            return true;
        }
        node = node.parent;
    }
    return false;
}

function selectorIsSafelisted(selector: string, safelist: RegExp[]): boolean {
    return safelist.some((pattern) => pattern.test(selector));
}

function collectSelectorRequirements(selectorNode: SelectorAstNode, options: CliOptions): SelectorRequirements {
    const requirements: SelectorRequirements = {
        classes: new Set(),
        ids: new Set(),
        tags: new Set(),
        attributes: [],
    };

    selectorNode.walk?.((node) => {
        if (isInsideNegation(node)) {
            return;
        }

        if (node.type === 'class' && node.value !== undefined && !options.ignoreClasses.has(node.value)) {
            requirements.classes.add(node.value);
            return;
        }

        if (node.type === 'id' && node.value !== undefined) {
            requirements.ids.add(node.value);
            return;
        }

        if (node.type === 'tag' && node.value !== undefined) {
            requirements.tags.add(node.value.toLowerCase());
            return;
        }

        if (
            node.type === 'attribute' && node.attribute !== undefined &&
            !options.ignoreAttributes.has(node.attribute.toLowerCase())
        ) {
            requirements.attributes.push({
                name: node.attribute.toLowerCase(),
                operator: node.operator,
                value: node.value,
            });
        }
    });

    return requirements;
}

function isInsideNegation(node: SelectorAstNode): boolean {
    let parent = node.parent;
    while (parent !== undefined) {
        if (parent.type === 'pseudo' && parent.value === ':not') {
            return true;
        }
        parent = parent.parent;
    }

    return false;
}

function missingRequirements(requirements: SelectorRequirements, usage: UsageIndex): string[] {
    const missing: string[] = [];

    for (const className of requirements.classes) {
        if (!usage.classes.has(className)) {
            missing.push(`class ${quote(className)}`);
        }
    }

    for (const id of requirements.ids) {
        if (!usage.ids.has(id)) {
            missing.push(`id ${quote(id)}`);
        }
    }

    for (const tag of requirements.tags) {
        if (!usage.tags.has(tag) && tag !== 'html' && tag !== 'body') {
            missing.push(`element ${quote(tag)}`);
        }
    }

    for (const attribute of requirements.attributes) {
        if (!attributeRequirementIsUsed(attribute, usage)) {
            missing.push(attributeDescription(attribute));
        }
    }

    return missing;
}

function attributeRequirementIsUsed(attribute: AttributeRequirement, usage: UsageIndex): boolean {
    const values = usage.attributes.get(attribute.name);
    if (values === undefined) {
        return false;
    }

    if (attribute.value === undefined) {
        return true;
    }

    if (attribute.operator === undefined || attribute.operator === '=') {
        return values.has(attribute.value);
    }

    for (const value of values) {
        if (attribute.operator === '~=' && splitWhitespace(value).includes(attribute.value)) {
            return true;
        }
        if (attribute.operator === '|=' && (value === attribute.value || value.startsWith(`${attribute.value}-`))) {
            return true;
        }
        if (attribute.operator === '^=' && value.startsWith(attribute.value)) {
            return true;
        }
        if (attribute.operator === '$=' && value.endsWith(attribute.value)) {
            return true;
        }
        if (attribute.operator === '*=' && value.includes(attribute.value)) {
            return true;
        }
    }

    return false;
}

function attributeDescription(attribute: AttributeRequirement): string {
    if (attribute.value === undefined) {
        return `attribute ${quote(attribute.name)}`;
    }

    return `attribute ${quote(`${attribute.name}${attribute.operator ?? '='}${attribute.value}`)}`;
}

function printSummary(cssFiles: string[], contentFiles: string[], unused: UnusedSelector[]): void {
    console.log(`Scanned ${cssFiles.length} CSS file(s) against ${contentFiles.length} content file(s)`);

    if (unused.length === 0) {
        console.log('No unused CSS selectors found');
        return;
    }

    console.log(`Possibly unused CSS selectors: ${unused.length}`);

    let currentFile = '';
    for (const item of unused) {
        if (item.cssFile !== currentFile) {
            currentFile = item.cssFile;
            console.log(`\n${currentFile}`);
        }

        console.log(`  ${item.line}:${item.column}  ${item.selector}`);
        console.log(`        missing ${item.missing.join(', ')}`);
    }
}

function splitWhitespace(value: string): string[] {
    return value.split(/\s+/).filter((part) => part.length > 0);
}

function unquote(value: string): string {
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return value.slice(1, -1);
    }

    return value;
}

function quote(value: string): string {
    return `"${value}"`;
}
