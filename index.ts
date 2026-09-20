import express, { Express, Request, Response, NextFunction } from 'express';
import clarificationRoutes from '@/routes/clarificationRoutes';

const app: Express = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', clarificationRoutes);

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Error handler
app.use((error: any, req: Request, res: Response, next: NextFunction) => {
  if (error.name === 'ValidationError') {
    res.status(400).json({ code: error.code || 'VALIDATION_ERROR', message: error.message });
    return;
  }
  if (error.name === 'NotFoundError') {
    res.status(404).json({ code: 'NOT_FOUND', message: error.message });
    return;
  }
  if (error.name === 'ForbiddenError') {  // ← ADD THIS
    res.status(403).json({ code: 'UNAUTHORIZED', message: error.message });
    return;
  }
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

// Start server
app.listen(PORT, () => {
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ Health check at /health`);
});

export default app;