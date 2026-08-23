const noAuthSecuritySchemes = [{type: 'noauth'}];

// @modelcontextprotocol/server@2.0.0 has no public hook for rewriting the
// serialized tools/list result. Keep this private-SDK compatibility boundary
// isolated so upgrades have one explicit review point.
export const applyRootNoAuthToolSecuritySchemes = (server) => {
  const handlers = server?.server?._requestHandlers;
  const originalToolsListHandler = handlers?.get?.('tools/list');
  if (typeof originalToolsListHandler !== 'function' || typeof handlers?.set !== 'function') {
    throw new Error('MCP SDK compatibility shim failed: tools/list handler not found in server._requestHandlers');
  }

  handlers.set('tools/list', async (request, extra) => {
    const result = await originalToolsListHandler(request, extra);
    if (!result || !Array.isArray(result.tools)) return result;

    return {
      ...result,
      tools: result.tools.map((tool) => {
        const {securitySchemes: _omitted, ...cleanAnnotations} = tool.annotations || {};
        const hasAnnotations = Object.keys(cleanAnnotations).length > 0;
        return {
          ...tool,
          annotations: hasAnnotations ? cleanAnnotations : undefined,
          securitySchemes: noAuthSecuritySchemes,
        };
      }),
    };
  });
};
