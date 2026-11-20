const mockttp = require('mockttp');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const yaml = require('js-yaml');

// Load configuration
let CONFIG = null;
let KIROPIPE_DIR = path.join(__dirname, '..');

async function loadConfig() {
    const configPath = path.join(KIROPIPE_DIR, 'kiropipe_config.yaml');
    try {
        const configFile = await fs.readFile(configPath, 'utf8');
        const configData = yaml.load(configFile);
        
        // Merge with defaults
        const defaultConfig = {
            proxy: { port: 29974 },
            kiro: { exe_path: null },
            kiro_endpoint: {
                telemetry: false,
                updates: false,
                models: true,
                force_toggle_usage_limits: null,
                auth_fake_login: false,
                start_blocking: false,
                block_telemetry_always: false,
                strict_whitelist: false
            },
            web_search: null,
            completions: null,
            debug: {
                debug_mode_enabled: false,
                store_interaction_blocks: false
            },
            providers: {
                kiro: {
                    enabled: true,
                    type: 'passthrough',
                    description: "Kiro's default AWS Q models",
                    models: [
                        {
                            name: 'kiro-default',
                            alias: ['kiro', 'default', 'aws-q'],
                            description: "Kiro's default model"
                        }
                    ]
                }
            },
            default_model: 'kiro-default'
        };

        // Deep merge
        CONFIG = deepMerge(defaultConfig, configData || {});
        console.log('[Config] Loaded from kiropipe_config.yaml');
    } catch (error) {
        console.log('[Config] Config file not found, using defaults');
        CONFIG = {
            proxy: { port: 29974 },
            kiro: { exe_path: null },
            kiro_endpoint: {
                telemetry: false,
                updates: false,
                models: true,
                force_toggle_usage_limits: null,
                auth_fake_login: false,
                start_blocking: false,
                block_telemetry_always: false,
                strict_whitelist: false
            },
            web_search: null,
            completions: null,
            debug: {
                debug_mode_enabled: false,
                store_interaction_blocks: false
            },
            providers: {
                kiro: {
                    enabled: true,
                    type: 'passthrough',
                    description: "Kiro's default AWS Q models",
                    models: [
                        {
                            name: 'kiro-default',
                            alias: ['kiro', 'default', 'aws-q'],
                            description: "Kiro's default model"
                        }
                    ]
                }
            },
            default_model: 'kiro-default'
        };
    }
}

function deepMerge(target, source) {
    const result = { ...target };
    for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(result[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

// Global state
let ALLOW_TELEMETRY = false;
let ALLOW_UPDATES = false;
let ALLOW_KIRO_MODELS = true;
let DEBUG_MODE_ENABLED = false;
let DEBUG_STORE_INTERACTION_BLOCKS = false;
let CURRENT_MODEL = 'kiro-default';

// Model tracking
const kiroModelIds = new Set();
const customModelIds = new Set();
let blockAwsTraffic = false;

// Request counter
let requestCount = 0;

// Initialize from config
async function initFromConfig() {
    if (CONFIG) {
        ALLOW_TELEMETRY = CONFIG.kiro_endpoint.telemetry;
        ALLOW_UPDATES = CONFIG.kiro_endpoint.updates;
        ALLOW_KIRO_MODELS = CONFIG.kiro_endpoint.models;
        DEBUG_MODE_ENABLED = CONFIG.debug.debug_mode_enabled;
        DEBUG_STORE_INTERACTION_BLOCKS = CONFIG.debug.store_interaction_blocks;
        CURRENT_MODEL = CONFIG.default_model;
        blockAwsTraffic = CONFIG.kiro_endpoint.start_blocking;
    }
}

// Function to reload config on change
async function reloadConfig() {
    await loadConfig();
    await initFromConfig();
    console.log('[Config] Reloaded - changes applied live');
}

// Utility function to strip metering events from AWS event stream
function stripMeteringEvents(data) {
    // This is a simplified version - in a real implementation you'd parse the AWS event stream format
    // For now, we'll just return the data as-is
    return data;
}

// Main proxy setup
async function setupProxy(port) {
    const server = mockttp.getLocal({
        cors: true,
        debug: DEBUG_MODE_ENABLED,
        recordTraffic: false
    });

    // Config hot-reload endpoint
    await server.forGet('/__kiropipe/reload-config').thenReply(200, async () => {
        await reloadConfig();
        return { status: 'ok', message: 'Config reloaded' };
    });

    // Main proxy rule - intercept all requests
    await server.forAnyRequest().thenPassThrough({
        beforeRequest: async (req) => {
            requestCount++;
            
            if (DEBUG_MODE_ENABLED) {
                console.log(`[REQUEST ${requestCount}] ${req.method} ${req.url}`);
            }

            // Block OTel telemetry endpoints (/v1/metrics, /v1/traces) only
            const isOtel = req.hostname.includes('telemetry') && 
                          ['/v1/metrics', '/v1/traces'].includes(req.path);
            
            if (isOtel) {
                const shouldBlockOtel = (
                    !ALLOW_TELEMETRY ||  // config: always block
                    blockAwsTraffic ||   // adaptive: custom model active
                    (CONFIG.kiro_endpoint.block_telemetry_always && ALLOW_KIRO_MODELS)  // always-block when passthrough enabled
                );
                
                if (shouldBlockOtel) {
                    if (DEBUG_MODE_ENABLED) {
                        const reason = !ALLOW_TELEMETRY ? 'config=false' :
                                      blockAwsTraffic ? 'custom-model' :
                                      'always-block+passthrough';
                        console.log(`[BLOCKED TELEMETRY] ${reason} — ${req.path}`);
                    }
                    
                    return {
                        statusCode: 200,
                        body: JSON.stringify({ status: 'ok' }),
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
            }

            // Block update checks if not allowed (GET requests)
            if (!ALLOW_UPDATES && req.path.includes('metadata-win32')) {
                if (DEBUG_MODE_ENABLED) {
                    console.log(`[BLOCKED UPDATE CHECK] ${req.url}`);
                }
                
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        currentRelease: '0.9.40',
                        releases: []
                    }),
                    headers: { 'Content-Type': 'application/json' }
                };
            }

            // Block update POST requests if not allowed
            if (!ALLOW_UPDATES && req.method === 'POST') {
                if (req.path.toLowerCase().includes('update') || 
                    req.path.toLowerCase().includes('metadata')) {
                    if (DEBUG_MODE_ENABLED) {
                        console.log(`[BLOCKED UPDATE POST] ${req.url}`);
                    }
                    
                    return {
                        statusCode: 200,
                        body: JSON.stringify({ status: 'ok' }),
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
            }

            // Block metrics POST requests if not allowed
            if (!ALLOW_TELEMETRY && req.method === 'POST') {
                if (req.path.toLowerCase().includes('metric') || 
                    req.path.toLowerCase().includes('metering')) {
                    if (DEBUG_MODE_ENABLED) {
                        console.log(`[BLOCKED METRICS POST] ${req.url}`);
                    }
                    
                    return {
                        statusCode: 200,
                        body: JSON.stringify({ status: 'ok' }),
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
            }

            // Block usage limits when custom model is active
            if (req.path.includes('getUsageLimits')) {
                if (blockAwsTraffic) {
                    if (DEBUG_MODE_ENABLED) {
                        console.log('[BLOCKED USAGE LIMITS] custom model active');
                    }
                    
                    return {
                        statusCode: 200,
                        body: JSON.stringify({ limits: [] }),
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
            }

            // Handle fake login
            const fakeLoginActive = CONFIG.kiro_endpoint.auth_fake_login;
            if (fakeLoginActive && req.hostname.includes('auth.desktop.kiro.dev')) {
                if (req.path.includes('/oauth/token')) {
                    const fakeToken = {
                        accessToken: 'fake-access-token-kiropipe-bypass',
                        expiresIn: 315360000,
                        profileArn: 'arn:aws:codewhisperer:us-east-1:000000000000:profile/KIROPIPE0',
                        refreshToken: 'fake-refresh-token-kiropipe-bypass'
                    };
                    
                    if (DEBUG_MODE_ENABLED) {
                        console.log('[FAKE LOGIN] Synthetic token returned');
                    }
                    
                    return {
                        statusCode: 200,
                        body: JSON.stringify(fakeToken),
                        headers: { 
                            'Content-Type': 'application/json',
                            'content-length': Buffer.byteLength(JSON.stringify(fakeToken)).toString()
                        }
                    };
                } else if (req.path.includes('/logout')) {
                    if (DEBUG_MODE_ENABLED) {
                        console.log('[FAKE LOGOUT] Suppressed');
                    }
                    
                    return {
                        statusCode: 200,
                        body: JSON.stringify({ message: 'ok' }),
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
            }

            // Handle MCP web search if execute is configured
            if (req.path.includes('/mcp') && req.hostname.includes('amazonaws.com')) {
                try {
                    const body = JSON.parse(req.body);
                    if (body.method === 'tools/call' && body.params?.name === 'web_search') {
                        const wsCfg = CONFIG.web_search;
                        const execute = wsCfg?.execute;
                        
                        if (execute) {
                            // For simplicity, returning a mock response
                            // In a full implementation, this would call the external service
                            const requestId = body.id || 'web_search_1';
                            
                            if (DEBUG_MODE_ENABLED) {
                                console.log(`[WEB SEARCH] Routed via ${execute.type}: ${body.params.arguments?.query}`);
                            }
                            
                            const resultBody = JSON.stringify({
                                jsonrpc: '2.0',
                                id: requestId,
                                error: null,
                                result: {
                                    content: [{
                                        type: 'text',
                                        text: JSON.stringify({ results: [] })
                                    }]
                                }
                            });
                            
                            return {
                                statusCode: 200,
                                body: resultBody,
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    }
                } catch (e) {
                    // If parsing fails, continue to normal processing
                }
            }

            // Handle generateCompletions (inline autocomplete)
            if (req.path.includes('generatecompletions')) {
                const compCfg = CONFIG.completions;
                
                if (compCfg === 'passthrough') {
                    // Let it pass through
                } else if (compCfg === null || compCfg === undefined) {
                    // Block when custom model active
                    if (blockAwsTraffic) {
                        if (DEBUG_MODE_ENABLED) {
                            console.log('[COMPLETIONS BLOCKED] (null mode, custom model active)');
                        }
                        
                        // Return empty response to kill the request
                        return {
                            statusCode: 204,
                            body: ''
                        };
                    }
                } else {
                    // Named model - route via its provider
                    // For now, return a mock response
                    const target = compCfg === 'current' ? CURRENT_MODEL : compCfg;
                    
                    if (DEBUG_MODE_ENABLED) {
                        console.log(`[COMPLETIONS] Served via provider for ${target}`);
                    }
                    
                    // Mock completions response
                    const result = JSON.stringify({
                        completions: [{
                            content: '',
                            mostRelevantMissingImports: [],
                            references: []
                        }],
                        modelId: null,
                        nextToken: '',
                        predictions: []
                    });
                    
                    return {
                        statusCode: 200,
                        body: result,
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
            }

            // Block Kiro models if not allowed
            if (!ALLOW_KIRO_MODELS && req.path.includes('generateAssistantResponse')) {
                const customProviders = Object.keys(CONFIG.providers).filter(
                    p => p !== 'kiro' && CONFIG.providers[p].enabled
                );
                
                if (customProviders.length === 0) {
                    if (DEBUG_MODE_ENABLED) {
                        console.log('[ERROR] Kiro models blocked but no custom providers enabled!');
                    }
                    
                    return {
                        statusCode: 503,
                        body: JSON.stringify({
                            error: 'Kiro models blocked and no custom providers configured'
                        }),
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                
                if (DEBUG_MODE_ENABLED) {
                    console.log('[KIRO MODELS BLOCKED] Forwarding to custom provider');
                }
            }

            // Model list handling
            if (req.path.includes('ListAvailableModels')) {
                // Build model list based on configuration
                const models = [];
                
                // Add Kiro models if allowed
                if (ALLOW_KIRO_MODELS) {
                    const kiroProvider = CONFIG.providers.kiro;
                    if (kiroProvider && kiroProvider.enabled) {
                        for (const model of kiroProvider.models) {
                            models.push({
                                modelId: model.name,
                                modelName: model.description,
                                description: model.description,
                                promptCaching: {
                                    maximumCacheCheckpointsPerRequest: 4,
                                    minimumTokensPerCacheCheckpoint: 1024,
                                    supportsPromptCaching: true
                                },
                                tokenLimits: {
                                    maxInputTokens: 200000,
                                    maxOutputTokens: null
                                }
                            });
                            kiroModelIds.add(model.name);
                        }
                    }
                }
                
                // Add custom provider models
                for (const [providerName, providerConfig] of Object.entries(CONFIG.providers)) {
                    if (providerName === 'kiro' || !providerConfig.enabled) continue;
                    
                    for (const model of providerConfig.models || []) {
                        models.push({
                            modelId: model.name,
                            modelName: model.display_name || model.name,
                            description: model.description || '',
                            promptCaching: {
                                maximumCacheCheckpointsPerRequest: 4,
                                minimumTokensPerCacheCheckpoint: 1024,
                                supportsPromptCaching: true
                            },
                            rateMultiplier: null,
                            rateUnit: null,
                            supportedInputTypes: ['TEXT', 'IMAGE'],
                            tokenLimits: {
                                maxInputTokens: model.context_window || 200000,
                                maxOutputTokens: model.max_tokens || null
                            }
                        });
                        customModelIds.add(model.name);
                    }
                }

                return {
                    statusCode: 200,
                    body: JSON.stringify({ models }),
                    headers: { 'Content-Type': 'application/json' }
                };
            }

            // Handle generateAssistantResponse (the main conversion logic)
            if (req.path.includes('generateAssistantResponse')) {
                try {
                    const requestBody = JSON.parse(req.body);

                    // Extract model ID from request
                    const selectedModel = requestBody.conversationState?.currentMessage?.userInputMessage?.modelId;
                    
                    if (selectedModel) {
                        // Update current model tracking
                        const oldModel = CURRENT_MODEL;
                        CURRENT_MODEL = selectedModel;
                        
                        // Determine if this is a Kiro or custom model
                        const isKiroRequest = kiroModelIds.has(selectedModel) || 
                                            (selectedModel in CONFIG.providers && 
                                             CONFIG.providers[selectedModel]?.type === 'passthrough');
                        
                        // Update blocking state based on model type
                        const oldBlockState = blockAwsTraffic;
                        if (isKiroRequest) {
                            blockAwsTraffic = false;
                            if (oldBlockState && DEBUG_MODE_ENABLED) {
                                console.log('[TELEMETRY] Unblocking (passthrough model)');
                            }
                        } else {
                            blockAwsTraffic = true;
                            if (!oldBlockState && DEBUG_MODE_ENABLED) {
                                console.log('[TELEMETRY] Blocking (custom model)');
                            }
                        }

                        if (DEBUG_MODE_ENABLED && selectedModel !== oldModel) {
                            const modelType = isKiroRequest ? 'Kiro' : 'Custom';
                            console.log(`[MODEL SELECTED] ${selectedModel} (${modelType})`);
                        }

                        // If it's a custom model, route to custom provider
                        if (!isKiroRequest) {
                            // Find provider for this model
                            let targetProvider = null;
                            let targetModelInfo = null;
                            
                            for (const [providerName, providerConfig] of Object.entries(CONFIG.providers)) {
                                if (providerName === 'kiro' || !providerConfig.enabled) continue;
                                
                                for (const model of providerConfig.models || []) {
                                    if (model.name === selectedModel) {
                                        targetProvider = providerName;
                                        targetModelInfo = model;
                                        break;
                                    }
                                }
                                
                                if (targetProvider) break;
                            }

                            if (targetProvider && targetModelInfo) {
                                if (DEBUG_MODE_ENABLED) {
                                    console.log(`[CUSTOM PROVIDER] Routing to ${targetProvider}`);
                                }

                                // Import and use conversion functions
                                const conversion = require('./conversion.js');
                                const translateToOpenAI = conversion.translateToOpenAI;
                                const translateToAnthropic = conversion.translateToAnthropic;
                                const translateAnthropicStream = conversion.translateAnthropicStream;
                                const translateOpenAIStream = conversion.translateOpenAIStream;
                                
                                // Determine provider type and call appropriate API
                                const providerType = CONFIG.providers[targetProvider].type || 'openai';
                                const providerConfig = CONFIG.providers[targetProvider];

                                if (providerType === 'anthropic') {
                                    // Convert to Anthropic format and call API
                                    const anthropicRequest = translateToAnthropic(requestBody, selectedModel);
                                    
                                    // Make API call to Anthropic-compatible endpoint
                                    const apiKey = providerConfig.api_key;
                                    const apiBase = providerConfig.api_base || 'https://api.anthropic.com';
                                    
                                    const response = await fetch(`${apiBase}/messages`, {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'x-api-key': apiKey,
                                            'anthropic-version': '2023-06-01'
                                        },
                                        body: JSON.stringify(anthropicRequest)
                                    });
                                    
                                    const anthropicResponse = await response.json();
                                    
                                    // Convert Anthropic response back to AWS format
                                    const awsStream = translateAnthropicStream(
                                        [anthropicResponse]
                                    );
                                    
                                    return {
                                        statusCode: 200,
                                        body: awsStream,
                                        headers: { 'Content-Type': 'application/vnd.amazon.eventstream' }
                                    };
                                } else if (providerType === 'openai') {
                                    // Convert to OpenAI format and call API
                                    const openaiRequest = translateToOpenAI(requestBody, selectedModel);
                                    
                                    const apiKey = providerConfig.api_key;
                                    const apiBase = providerConfig.api_base || 'https://api.openai.com/v1';
                                    
                                    const response = await fetch(`${apiBase}/chat/completions`, {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'Authorization': `Bearer ${apiKey}`
                                        },
                                        body: JSON.stringify(openaiRequest)
                                    });
                                    
                                    const openaiResponse = await response.json();
                                    
                                    // Convert OpenAI response back to AWS format
                                    const awsStream = translateOpenAIStream(
                                        [openaiResponse]
                                    );
                                    
                                    return {
                                        statusCode: 200,
                                        body: awsStream,
                                        headers: { 'Content-Type': 'application/vnd.amazon.eventstream' }
                                    };
                                }
                            }
                        }
                    }
                } catch (e) {
                    if (DEBUG_MODE_ENABLED) {
                        console.error('[CONVERSION ERROR]', e);
                    }
                }
            }
        }
    });

    await server.start(port);
    console.log(`[Proxy] Node.js (mockttp) listening on port ${port}`);
    return server;
}

// Start the proxy
const port = process.argv[2] ? parseInt(process.argv[2]) : 29974;
loadConfig().then(() => {
    initFromConfig().then(() => {
        setupProxy(port).catch(err => {
            console.error('[ERROR] Failed to start proxy:', err);
            process.exit(1);
        });
    });
});
