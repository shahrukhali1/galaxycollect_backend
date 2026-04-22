const isRootPath = (url: string | undefined) => {
  if (!url) return false;
  const [pathname] = url.split('?');
  return pathname === '/' || pathname === '';
};

export default async function handler(req: any, res: any) {
  if (isRootPath(req.url)) {
    return res.status(200).json({
      status: 'ok',
      message: 'Backend function reachable'
    });
  }

  try {
    const { default: app } = await import('./index.ts');
    return app(req, res);
  } catch (error: any) {
    console.error('Function bootstrap error:', error);
    return res.status(500).json({
      error: 'FUNCTION_BOOTSTRAP_FAILED',
      message: error?.message || 'Unknown server startup error'
    });
  }
}

