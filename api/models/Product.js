import mongoose from 'mongoose';

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mainImage: { type: String, required: true },
  category: { type: String, required: true },
  regularPrice: { type: Number, required: true },
  salePrice: { type: Number },
  fullDescription: { type: String, required: true },
  stockStatus: { type: String, default: 'In Stock' },
  quantity: { type: Number, required: true },
  isTrending: { type: Boolean, default: false },
  status: { type: String, default: 'Active' }
}, {
  timestamps: true
});

ProductSchema.index({ createdAt: -1 });
ProductSchema.index({ category: 1, createdAt: -1 });

const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
export default Product;
