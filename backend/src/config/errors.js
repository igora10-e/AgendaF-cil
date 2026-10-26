export class HttpError extends Error {
  constructor(status, detail) {
    super(typeof detail === 'string' ? detail : 'Dados inválidos.');
    this.status = status;
    this.detail = detail;
  }
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) return res.status(error.status).json({ detail: error.detail });
  if (error.type === 'entity.too.large')
    return res.status(413).json({ detail: 'Dados enviados excedem o limite permitido.' });
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error)
    return res.status(400).json({ detail: 'JSON inválido.' });
  if (error.status === 404) return res.status(404).json({ detail: 'Arquivo não encontrado.' });
  console.error('Erro na API:', error.message);
  return res.status(500).json({ detail: 'Não foi possível concluir a ação. Tente novamente.' });
}

export function positiveId(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new HttpError(422, 'Identificador inválido.');
  return Number(value);
}
