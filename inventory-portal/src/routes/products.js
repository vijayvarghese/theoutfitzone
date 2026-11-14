import express from 'express';
import { api } from '../api.js';
import { upload } from '../upload.js';
import { requireAuth, requireRole } from '../auth.js';
import {
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanFloat,
  cleanBool,
  cleanUrl
} from '../sanitize.js';

const router = express.Router();

router.use(requireAuth);

function getActor(req) {
  return req.user ? `${req.user.name} [${req.user.role}]` : 'Staff';
}

// List silhouettes with rich filtering
router.get('/', async (req, res, next) => {
  try {
    const q = cleanString(req.query.q);
    const category = cleanString(req.query.category);
    const status = cleanString(req.query.status, { toLower: true }) || 'all';
    const image = cleanString(req.query.image, { toLower: true }) || 'all';
    const sort = cleanString(req.query.sort, { toLower: true }) || 'id-asc';

    const [products, categories] = await Promise.all([
      api.listStaffProducts({ q, category, status, image, sort }),
      api.getProductCategories()
    ]);

    res.render('products/index', {
      title: 'Silhouettes & Product Catalog',
      currentPath: '/products',
      products,
      categories,
      filters: { q, category: category || 'all', status, image, sort }
    });
  } catch (err) {
    next(err);
  }
});

// Render Add Product Form
router.get('/new', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const categories = await api.getProductCategories();

    res.render('products/form', {
      title: 'Add New Silhouette / Product',
      currentPath: '/products',
      isEdit: false,
      product: {
        id: null,
        name: '',
        category: '',
        price_inr: '',
        description: '',
        image_url: '',
        active: true
      },
      categories,
      variants: []
    });
  } catch (err) {
    next(err);
  }
});

// Create New Product
router.post('/', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  try {
    const name = cleanString(req.body.name, { maxLength: 200 });
    const category = cleanString(req.body.category, { maxLength: 100 });
    const custom_category = cleanString(req.body.custom_category, { maxLength: 100 });
    const priceNum = cleanFloat(req.body.price_inr, 0, 10000000, 2, -1);
    const description = cleanString(req.body.description, { maxLength: 5000, allowNewlines: true });
    const active = cleanBool(req.body.active);
    const manual_image_url = cleanUrl(req.body.manual_image_url);

    if (!name || name.length < 2) {
      throw new Error('Product name must be at least 2 characters long.');
    }
    const finalCategory = custom_category || (category && category !== '__new__' ? category : null);
    if (!finalCategory || finalCategory.trim().length === 0) {
      throw new Error('Category is required. Please select or enter a category.');
    }
    if (priceNum < 0) {
      throw new Error('Please enter a valid base price in INR.');
    }
    if (!description || description.trim().length === 0) {
      throw new Error('Detailed description is required.');
    }

    let imageUrl = null;
    if (req.file) {
      imageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url) {
      imageUrl = manual_image_url;
    }

    // Parse variant arrays from form
    const skus = Array.isArray(req.body['var_sku']) ? req.body['var_sku'] : (req.body['var_sku'] ? [req.body['var_sku']] : []);
    const sizes = Array.isArray(req.body['var_size']) ? req.body['var_size'] : (req.body['var_size'] ? [req.body['var_size']] : []);
    const colours = Array.isArray(req.body['var_colour']) ? req.body['var_colour'] : (req.body['var_colour'] ? [req.body['var_colour']] : []);
    const stocks = Array.isArray(req.body['var_stock']) ? req.body['var_stock'] : (req.body['var_stock'] ? [req.body['var_stock']] : []);
    const reorders = Array.isArray(req.body['var_reorder']) ? req.body['var_reorder'] : (req.body['var_reorder'] ? [req.body['var_reorder']] : []);

    const variants = [];
    const maxLen = Math.max(skus.length, sizes.length, colours.length, stocks.length);
    for (let i = 0; i < maxLen; i++) {
      variants.push({
        sku: cleanIdentifier(skus[i], '-_'),
        size: cleanString(sizes[i], { maxLength: 50 }),
        colour: cleanString(colours[i], { maxLength: 50 }),
        on_hand: cleanInt(stocks[i], 0, 100000, 0),
        reorder_level: cleanInt(reorders[i], 0, 100000, 2)
      });
    }

    const created = await api.createProduct({
      name,
      category: finalCategory,
      price_inr: priceNum,
      description,
      image_url: imageUrl,
      active,
      variants
    }, getActor(req));

    const newId = created.product?.id || '';
    res.redirect(`/products?flash=${encodeURIComponent(`Product "${name}" created successfully with ID #${newId}.`)}`);
  } catch (err) {
    res.redirect(`/products/new?error=${encodeURIComponent(err.message)}`);
  }
});

// Render Edit Product Form
router.get('/:id/edit', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const productId = cleanInt(req.params.id, 1);
    if (!productId) {
      return res.status(404).render('error', { title: 'Invalid Product ID', message: 'Product ID must be a positive integer.' });
    }

    const [data, categories] = await Promise.all([
      api.getProduct(productId),
      api.getProductCategories()
    ]);

    if (!data || !data.product) {
      return res.status(404).render('error', { title: 'Product Not Found', message: `Product #${productId} does not exist.` });
    }

    res.render('products/form', {
      title: `Edit Silhouette #${productId} - ${data.product.name}`,
      currentPath: '/products',
      isEdit: true,
      product: data.product,
      categories,
      variants: data.variants || []
    });
  } catch (err) {
    next(err);
  }
});

// Update Product
router.post('/:id', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  const productId = cleanInt(req.params.id, 1);
  try {
    if (!productId) throw new Error('Invalid product ID');

    const name = cleanString(req.body.name, { maxLength: 200 });
    const category = cleanString(req.body.category, { maxLength: 100 });
    const custom_category = cleanString(req.body.custom_category, { maxLength: 100 });
    const priceNum = cleanFloat(req.body.price_inr, 0, 10000000, 2, -1);
    const description = cleanString(req.body.description, { maxLength: 5000, allowNewlines: true });
    const active = cleanBool(req.body.active);
    const remove_image = req.body.remove_image === '1' || req.body.remove_image === 'true';
    const manual_image_url = cleanUrl(req.body.manual_image_url);

    if (!name || name.length < 2) {
      throw new Error('Product name is required.');
    }
    const finalCategory = custom_category || (category && category !== '__new__' ? category : null);
    if (!finalCategory || finalCategory.trim().length === 0) {
      throw new Error('Category is required. Please select or enter a category.');
    }
    if (priceNum < 0) {
      throw new Error('Please enter a valid base price in INR.');
    }
    if (!description || description.trim().length === 0) {
      throw new Error('Detailed description is required.');
    }

    let imageUrl = undefined;
    if (remove_image) {
      imageUrl = null;
    } else if (req.file) {
      imageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url) {
      imageUrl = manual_image_url;
    }

    const payload = {
      name,
      category: finalCategory,
      price_inr: priceNum,
      description,
      active
    };
    if (imageUrl !== undefined) {
      payload.image_url = imageUrl;
    }
    if (remove_image) {
      payload.remove_image = true;
    }

    await api.updateProduct(productId, payload, getActor(req));

    res.redirect(`/products?flash=${encodeURIComponent(`Silhouette #${productId} updated successfully.`)}`);
  } catch (err) {
    res.redirect(`/products/${productId}/edit?error=${encodeURIComponent(err.message)}`);
  }
});

// Standalone Fast Image Upload for Product
router.post('/:id/upload-image', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  const productId = cleanInt(req.params.id, 1);
  try {
    if (!productId) throw new Error('Invalid product ID');
    if (!req.file) {
      return res.status(400).json({ error: 'No image file was provided.' });
    }

    const imageUrl = `/products/${req.file.filename}`;
    await api.updateProduct(productId, { image_url: imageUrl }, getActor(req));

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, image_url: imageUrl });
    }
    res.redirect(`/products?flash=${encodeURIComponent(`Image for product #${productId} updated successfully.`)}`);
  } catch (err) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ error: err.message });
    }
    res.redirect(`/products?error=${encodeURIComponent(err.message)}`);
  }
});

// Upload / Update Photo for all variants of a specific colour for this product
router.post('/:id/color-image', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  const productId = cleanInt(req.params.id, 1);
  const redirectTarget = req.headers.referer || `/products/${productId}/edit`;
  try {
    if (!productId) throw new Error('Invalid product ID');
    const colour = cleanString(req.body.colour, { maxLength: 50 });
    const remove_image = req.body.remove_image === '1' || req.body.remove_image === 'true';
    const manual_image_url = cleanUrl(req.body.manual_image_url);

    if (!colour) {
      throw new Error('Colour name is required.');
    }

    let finalImageUrl = null;
    if (remove_image) {
      finalImageUrl = null;
    } else if (req.file) {
      finalImageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url) {
      finalImageUrl = manual_image_url;
    } else {
      throw new Error('No image file or URL was provided.');
    }

    await api.updateColorImage(productId, {
      colour,
      image_url: finalImageUrl,
      remove_image
    }, getActor(req));

    const msg = finalImageUrl
      ? `Photo updated for colour "${colour}".`
      : `Photo removed for colour "${colour}".`;

    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}flash=${encodeURIComponent(msg)}`);
  } catch (err) {
    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}error=${encodeURIComponent(err.message)}`);
  }
});

// Toggle Active / Archived Status
router.post('/:id/toggle-status', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const productId = cleanInt(req.params.id, 1);
    if (!productId) throw new Error('Invalid product ID');

    const updated = await api.toggleProductStatus(productId, getActor(req));
    const statusText = updated.active ? 'activated' : 'archived';
    res.redirect(`/products?flash=${encodeURIComponent(`Silhouette "${updated.name}" has been ${statusText}.`)}`);
  } catch (err) {
    next(err);
  }
});

// Delete Product (Cascade)
router.post('/:id/delete', requireRole('owner'), async (req, res, next) => {
  try {
    const productId = cleanInt(req.params.id, 1);
    if (!productId) throw new Error('Invalid product ID');

    const deleted = await api.deleteProduct(productId, getActor(req));
    res.redirect(`/products?flash=${encodeURIComponent(`Product #${productId} ("${deleted.name}") and all its variants have been permanently removed.`)}`);
  } catch (err) {
    next(err);
  }
});

export default router;
