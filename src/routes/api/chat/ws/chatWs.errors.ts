// ws parse error

export class ChatWsParseError extends Error {
    readonly code: string;

    constructor(code: string) {
        // init error
        super(code);

        // set error metadata
        this.name = 'ChatWsParseError';
        this.code = code;
    }
}