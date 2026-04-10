// XGBoost inference in TypeScript — evaluates exported tree JSON.
// 150 trees, max depth 3. Runs in <1ms per prediction.

import modelData from './ml-model.json';

interface TreeNode {
    nodeid: number;
    split?: string;       // feature name
    split_condition?: number;
    yes?: number;
    no?: number;
    missing?: number;
    leaf?: number;
    children?: TreeNode[];
}

const features: string[] = modelData.features;
const trees: TreeNode[] = modelData.trees;

function evaluateTree(node: TreeNode, input: Record<string, number>): number {
    if (node.leaf !== undefined) return node.leaf;
    if (!node.split || node.split_condition === undefined) return 0;

    const val = input[node.split] ?? 0;
    const goLeft = val < node.split_condition;

    const children = node.children || [];
    const yesNode = children.find(c => c.nodeid === node.yes);
    const noNode = children.find(c => c.nodeid === node.no);

    const next = goLeft ? yesNode : noNode;
    if (!next) return 0;
    return evaluateTree(next, input);
}

function sigmoid(x: number): number {
    return 1.0 / (1.0 + Math.exp(-x));
}

/// Returns win probability (0.0 to 1.0)
export function mlPredict(input: Record<string, number>): number {
    let sum = 0;
    for (const tree of trees) {
        sum += evaluateTree(tree, input);
    }
    return sigmoid(sum);
}

/// Build feature dict from scoring results + candle data
export function buildMLInput(
    dRsi: number, dMacdHist: number, dAdx: number, dAdxBullish: boolean,
    dEmaCross: number, dStackBull: boolean, dStackBear: boolean,
    dStructBull: boolean, dStructBear: boolean,
    hRsi: number, hMacdHist: number, hAdx: number, hAdxBullish: boolean,
    hEmaCross: number, hStackBull: boolean, hStackBear: boolean,
    hStructBull: boolean, hStructBear: boolean,
    atrPercent: number, volScalar: number, atrPercentile: number,
    dailyScore: number, fourHScore: number
): Record<string, number> {
    return {
        dRsi, dMacdHist, dAdx, dAdxBullish: dAdxBullish ? 1 : 0,
        dEmaCross, dStackBull: dStackBull ? 1 : 0, dStackBear: dStackBear ? 1 : 0,
        dStructBull: dStructBull ? 1 : 0, dStructBear: dStructBear ? 1 : 0,
        hRsi, hMacdHist, hAdx, hAdxBullish: hAdxBullish ? 1 : 0,
        hEmaCross, hStackBull: hStackBull ? 1 : 0, hStackBear: hStackBear ? 1 : 0,
        hStructBull: hStructBull ? 1 : 0, hStructBear: hStructBear ? 1 : 0,
        atrPercent, volScalar, atrPercentile,
        dailyScore, fourHScore
    };
}
