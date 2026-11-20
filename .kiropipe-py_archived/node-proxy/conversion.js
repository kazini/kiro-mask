const { PassThrough } = require('stream');

// Helper to extract user message
function extractUserMessage(awsRequest) {
    try {
        const convState = awsRequest.conversationState || {};
        const currentMsg = convState.currentMessage || {};
        const userInput = currentMsg.userInputMessage || {};
        return userInput.content || '';
    } catch (e) {
        throw new Error(`Failed to extract user message: ${e.message}`);
    }
}

// Helper to extract tools
function extractTools(awsRequest) {
    try {
        const convState = awsRequest.conversationState || {};
        const currentMsg = convState.currentMessage || {};
        const userInput = currentMsg.userInputMessage || {};
        const context = userInput.userInputMessageContext || {};
        const awsTools = context.tools || [];
        
        if (!awsTools.length) return null;
        
        return awsTools.map(tool => {
            const toolSpec = tool.toolSpecification || tool;
            const anthropicTool = {
                name: toolSpec.name || '',
                description: toolSpec.description || ''
            };
            
            if (toolSpec.inputSchema) {
                anthropicTool.input_schema = toolSpec.inputSchema;
            }
            
            return anthropicTool;
        });
    } catch (e) {
        console.warn(`Failed to extract tools: ${e.message}`);
        return null;
    }
}

// Convert tool result content
function extractToolContent(resultContent) {
    if (Array.isArray(resultContent)) {
        return resultContent
            .map(item => item.text || item)
            .join('\n');
    }
    return resultContent || '';
}

// Convert tool result to Anthropic block
function toolResultToAnthropicBlock(result) {
    const content = extractToolContent(result.content);
    const status = result.status || 'success';
    
    const block = {
        type: 'tool_result',
        tool_use_id: result.toolUseId || '',
        content: content
    };
    
    if (!['success', 'ok', ''].includes(status.toLowerCase())) {
        const errorMsg = result.error || content || 'Tool execution failed';
        block.content = `Error: ${errorMsg}`;
        block.is_error = true;
    }
    
    return block;
}

// Convert AWS tool use to Anthropic block
function awsToolUseToAnthropicBlock(toolUse) {
    let inputDict = {};
    const inputVal = toolUse.input || {};
    
    if (typeof inputVal === 'string') {
        try {
            inputDict = JSON.parse(inputVal || '{}');
        } catch (e) {
            inputDict = {};
        }
    } else {
        inputDict = inputVal || {};
    }
    
    return {
        type: 'tool_use',
        id: toolUse.toolUseId || '',
        name: toolUse.name || '',
        input: inputDict
    };
}

// Convert to Anthropic format
function translateToAnthropic(awsRequest, model = 'claude-3-5-sonnet-20241022') {
    const userMessage = extractUserMessage(awsRequest);
    const tools = extractTools(awsRequest);
    const toolResults = extractToolResults(awsRequest);
    const convState = awsRequest.conversationState || {};
    const awsHistory = convState.history || [];
    
    const messages = [];
    
    // Process history
    for (let i = 0; i < awsHistory.length; i++) {
        const item = awsHistory[i];
        
        if (item.userInputMessage) {
            const userIn = item.userInputMessage;
            const textContent = userIn.content || '';
            const toolRes = userIn.userInputMessageContext?.toolResults || [];
            
            if (toolRes.length > 0) {
                // Synthesize assistant tool use if needed
                let asstContent = [];
                if (i > 0 && awsHistory[i-1].assistantResponseMessage?.toolUse) {
                    const prevAsst = awsHistory[i-1].assistantResponseMessage;
                    asstContent = (prevAsst.content ? [{type: 'text', text: prevAsst.content}] : [])
                        .concat(prevAsst.toolUse.map(awsToolUseToAnthropicBlock));
                } else {
                    // Generate from results
                    const toolUses = toolRes.map(r => ({
                        toolUseId: r.toolUseId,
                        name: r.toolUseId.replace('tooluse_', ''),
                        input: {}
                    }));
                    asstContent = toolUses.map(awsToolUseToAnthropicBlock);
                }
                
                messages.push({ role: 'assistant', content: asstContent });
                
                // Add results
                const resultBlocks = toolRes.map(toolResultToAnthropicBlock);
                let userContent = resultBlocks;
                if (textContent) {
                    userContent = [{type: 'text', text: textContent}].concat(resultBlocks);
                }
                messages.push({ role: 'user', content: userContent });
            } else if (textContent) {
                messages.push({ role: 'user', content: textContent });
            }
        } else if (item.assistantResponseMessage) {
            const asstMsg = item.assistantResponseMessage;
            if (asstMsg.toolUse) continue; // Handled with results
            if (asstMsg.content) {
                messages.push({ role: 'assistant', content: asstMsg.content });
            }
        }
    }

// Translate AWS request to OpenAI format
function translateToOpenAI(awsRequest, model = 'gpt-4') {
    const messages = [];
    const convState = awsRequest.conversationState || {};
    const history = convState.history || [];
    
    // Process history
    for (let i = 0; i < history.length; i++) {
        const item = history[i];
        
        if (item.userInputMessage) {
            const userInput = item.userInputMessage;
            const textContent = userInput.content || '';
            const context = userInput.userInputMessageContext || {};
            const toolResults = context.toolResults || [];
            
            if (toolResults.length > 0) {
                // Tool result turn
                // Add preceding assistant tool calls if available
                if (i > 0 && history[i-1].assistantResponseMessage && history[i-1].assistantResponseMessage.toolUse) {
                    const prevAssistant = history[i-1].assistantResponseMessage;
                    messages.push({
                        role: 'assistant',
                        tool_calls: prevAssistant.toolUse.map(tu => ({
                            id: tu.toolUseId,
                            type: 'function',
                            function: {
                                name: tu.name,
                                arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {})
                            }
                        }))
                    });
                } else {
                    // Synthesize tool calls from results
                    messages.push({
                        role: 'assistant',
                        tool_calls: toolResults.map(r => {
                            const toolId = r.toolUseId || '';
                            const name = toolId.startsWith('tooluse_') ? toolId.substring(8) : toolId;
                            return {
                                id: toolId,
                                type: 'function',
                                function: {
                                    name: name,
                                    arguments: '{}'
                                }
                            };
                        })
                    });
                }
                
                // Add tool results
                toolResults.forEach(r => {
                    let content = '';
                    if (Array.isArray(r.content)) {
                        content = r.content.map(c => c.text || c).join('\n');
                    } else {
                        content = r.content || '';
                    }
                    
                    if (r.status && r.status.toLowerCase() !== 'success' && r.status.toLowerCase() !== 'ok') {
                        content = `Error: ${r.error || content || 'Tool execution failed'}`;
                    }
                    
                    messages.push({
                        role: 'tool',
                        tool_call_id: r.toolUseId,
                        content: content
                    });
                });
                
                if (textContent) {
                    messages.push({ role: 'user', content: textContent });
                }
            } else if (textContent) {
                messages.push({ role: 'user', content: textContent });
            }
        } else if (item.assistantResponseMessage) {
            const assistantMsg = item.assistantResponseMessage;
            if (!assistantMsg.toolUse) {
                if (assistantMsg.content) {
                    messages.push({ role: 'assistant', content: assistantMsg.content });
                }
            }
            // Skip tool use messages here as they are handled with the results
        }
    }
    
    // Add current message
    const currentMsg = convState.currentMessage || {};
    const userInput = currentMsg.userInputMessage || {};
    const textContent = userInput.content || '';
    const context = userInput.userInputMessageContext || {};
    const toolResults = context.toolResults || [];
    
    if (toolResults.length > 0) {
        // Reconstruct assistant message that triggered these tools
        // In a real implementation we'd use a cache, here we synthesize
        messages.push({
            role: 'assistant',
            tool_calls: toolResults.map(r => {
                const toolId = r.toolUseId || '';
                const name = toolId.startsWith('tooluse_') ? toolId.substring(8) : toolId;
                return {
                    id: toolId,
                    type: 'function',
                    function: {
                        name: name,
                        arguments: '{}'
                    }
                };
            })
        });
        
        // Add tool results
        toolResults.forEach(r => {
            let content = '';
            if (Array.isArray(r.content)) {
                content = r.content.map(c => c.text || c).join('\n');
            } else {
                content = r.content || '';
            }
            
            messages.push({
                role: 'tool',
                tool_call_id: r.toolUseId,
                content: content
            });
        });
        
        if (textContent) {
            messages.push({ role: 'user', content: textContent });
        }
    } else if (textContent) {
        messages.push({ role: 'user', content: textContent });
    }
    
    // Extract tools
    const tools = extractTools(awsRequest);
    
    const request = {
        model: model,
        messages: messages,
        stream: true
    };
    
    if (tools && tools.length > 0) {
        request.tools = tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            }
        }));
    }
    
    return request;
}

// Translate Anthropic stream to AWS format
function translateAnthropicStream(events) {
    const awsEvents = [];
    
    // Helper to add event
    function addEvent(type, payload) {
        awsEvents.push({
            headers: {
                ':event-type': { type: 7, value: type },
                ':content-type': { type: 7, value: 'application/json' },
                ':message-type': { type: 7, value: 'event' }
            },
            payload: payload
        });
    }
    
    for (const event of events) {
        if (event.type === 'message_start') {
            // Can extract usage
        } else if (event.type === 'content_block_start') {
            if (event.content_block && event.content_block.type === 'tool_use') {
                addEvent('toolUseEvent', {
                    toolUseId: event.content_block.id,
                    name: event.content_block.name,
                    input: ''
                });
            }
        } else if (event.type === 'content_block_delta') {
            if (event.delta && event.delta.type === 'text_delta') {
                addEvent('assistantResponseEvent', {
                    content: event.delta.text
                });
            } else if (event.delta && event.delta.type === 'input_json_delta') {
                addEvent('toolUseEvent', {
                    toolUseId: event.index, // Simplified mapping
                    input: event.delta.partial_json
                });
            }
        } else if (event.type === 'content_block_stop') {
            // End of block
        } else if (event.type === 'message_stop') {
            // End of message
        }
    }
    
    return awsEvents;
}

// Encode AWS events to binary stream format
function encodeAwsEventStream(events) {
    const chunks = [];
    
    for (const event of events) {
        // Calculate payload
        const payloadStr = JSON.stringify(event.payload);
        const payloadBytes = Buffer.from(payloadStr, 'utf8');
        
        // Calculate headers
        const headersBytes = [];
        for (const [name, value] of Object.entries(event.headers)) {
            const nameBytes = Buffer.from(name, 'utf8');
            const valueBytes = Buffer.from(value.value, 'utf8');
            
            headersBytes.push(Buffer.from([nameBytes.length]));
            headersBytes.push(nameBytes);
            headersBytes.push(Buffer.from([value.type]));
            
            const valueLen = Buffer.alloc(2);
            valueLen.writeUInt16BE(valueBytes.length);
            headersBytes.push(valueLen);
            headersBytes.push(valueBytes);
        }
        
        const allHeaders = Buffer.concat(headersBytes);
        
        // Calculate total length
        const totalLen = 12 + allHeaders.length + payloadBytes.length + 4; // +4 for message CRC
        
        const prelude = Buffer.alloc(12);
        prelude.writeUInt32BE(totalLen, 0);
        prelude.writeUInt32BE(allHeaders.length, 4);
        
        // CRC for prelude
        const crc32 = require('zlib').crc32;
        const preludeCrc = crc32(prelude.slice(0, 8));
        prelude.writeUInt32BE(preludeCrc, 8);
        
        // Combine everything
        const message = Buffer.concat([
            prelude,
            allHeaders,
            payloadBytes
        ]);
        
        // Message CRC
        const msgCrc = crc32(message);
        const msgCrcBuf = Buffer.alloc(4);
        msgCrcBuf.writeUInt32BE(msgCrc);
        
        chunks.push(Buffer.concat([message, msgCrcBuf]));
    }
    
    return Buffer.concat(chunks);
}

module.exports = {
    translateToAnthropic,
    translateToOpenAI,
    translateAnthropicStream,
    encodeAwsEventStream
};
