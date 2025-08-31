/**
 * TS declaration for JS modules
 */

declare class KuromojiAnalyzer {
    constructor(dictPath?: { dictPath: string });
    init(): Promise<void>;
    parse(str: string): Promise<any>;
}

declare module "kuroshiro-analyzer-kuromoji" {
    export default KuromojiAnalyzer;
}

declare module "kuroshiro" {
    export default class Kuroshiro {
        static Util: any;
        constructor();
        init(analyzer: any): Promise<void>;
        convert(text: string, options?: any): Promise<string>;
    }
}