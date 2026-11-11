import express from 'express';
import { api } from '../api.js';
import { requireAuth } from '../auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const data = await api.getDashboardData({
      includeOrders: Boolean(res.locals.canManageOrders)
    });

    res.render('dashboard', {
      title: 'Staff Operations & Inventory Dashboard',
      currentPath: '/',
      kpis: data.kpis || {},
      lowStockItems: data.lowStockItems || [],
      recentMovements: data.recentMovements || [],
      categories: data.categories || [],
      products: data.products || [],
      orderMetrics: data.orderMetrics || null,
      recentOrders: data.recentOrders || [],
      couponMetrics: data.couponMetrics || null
    });
  } catch (err) {
    next(err);
  }
});

export default router;
