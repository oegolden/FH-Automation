const { WebClient } = require('@slack/web-api');

describe('Slack WebClient', () => {
    it('should be able to initialize a Slack WebClient', () => {
        const token = 'xoxb-dummy-token';
        const web = new WebClient(token);
        expect(web).toBeDefined();
        expect(web.token).toBe(token);
    });

    it('should have chat.postMessage available', () => {
        const token = 'xoxb-dummy-token';
        const web = new WebClient(token);
        expect(typeof web.chat.postMessage).toBe('function');
    });
});
