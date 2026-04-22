import mongoose from 'mongoose';

const BannerSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subtitle: { type: String, required: true },
  description: { type: String, required: true },
  image: { type: String, required: true },
  cta: { type: String, required: true },
  color: { type: String, default: 'bg-blue-50' },
  isActive: { type: Boolean, default: true, index: true }
}, {
  timestamps: true
});

BannerSchema.index({ isActive: 1, createdAt: -1 });

const Banner = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);
export default Banner;
