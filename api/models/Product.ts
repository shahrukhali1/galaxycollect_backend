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

export interface IProduct extends mongoose.Document {
  name: string;
  mainImage: string;
  category: string;
  regularPrice: number;
  salePrice?: number;
  fullDescription: string;
  stockStatus: string;
  quantity: number;
  isTrending: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const Product = mongoose.models.Product || mongoose.model<IProduct>('Product', ProductSchema);
export default Product;
