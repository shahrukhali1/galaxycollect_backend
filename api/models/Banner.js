import mongoose from 'mongoose';

const BannerSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subtitle: { type: String },
  description: { type: String },
  image: { type: String, required: true },
  cta: { type: String, default: 'Shop Now' },
  link: { type: String, default: '/shop' },
  color: { type: String, default: 'bg-stone-50' },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

const Banner = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);
export default Banner;
