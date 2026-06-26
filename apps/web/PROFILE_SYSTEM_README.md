# Profile System with BuySportsCards Integration

This document explains the new profile system that allows users to securely store their BuySportsCards credentials.

## Overview

The profile system provides:
- Secure storage of BuySportsCards credentials (encrypted)
- User preferences management
- Credential testing functionality
- Profile page with intuitive UI

## Files Created

### Backend (Convex)
- `convex/schema.ts` - Updated with `userProfiles` table
- `convex/userProfile.ts` - Profile management functions with encryption

### Frontend (Next.js)
- `app/profile/page.tsx` - Profile settings page
- `app/page.tsx` - Updated with profile icon navigation

## Database Schema

```typescript
userProfiles: defineTable({
  userId: v.id("users"),
  bscUsername: v.optional(v.string()), // Encrypted
  bscPassword: v.optional(v.string()), // Encrypted
  preferences: v.optional(v.object({
    defaultSport: v.optional(v.string()),
    defaultYear: v.optional(v.number()),
    theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
  })),
}).index("by_user", ["userId"])
```

## Security Features

### Encryption
- Uses AES-256-CBC encryption for credentials
- Each encryption uses a random IV (Initialization Vector)
- Credentials are encrypted before storage and decrypted when retrieved

### Access Control
- Only authenticated users can access their profile
- Users can only access their own profile data
- Credentials are automatically cleared when user signs out

## Setup Instructions

### 1. Environment Variables
Create a `.env.local` file in your project root:

```bash
# Encryption key for user profile credentials (32 characters)
ENCRYPTION_KEY=your-secret-key-32-chars-long!!

# Other environment variables...
```

**Important**: Generate a secure 32-character encryption key for production!

### 2. Deploy Schema Changes
```bash
npx convex dev
```

This will deploy the new `userProfiles` table to your Convex deployment.

### 3. Test the System
1. Start your development server
2. Sign in to your application
3. Click the profile icon (user icon) in the header
4. Enter your BuySportsCards credentials
5. Test the credentials using the "Test Credentials" button

## API Functions

### Queries
- `getUserProfile()` - Get current user's profile with decrypted credentials

### Mutations
- `updateUserProfile()` - Update profile with encrypted credentials
- `clearBuySportsCardsCredentials()` - Remove stored credentials

### Actions
- `testBuySportsCardsCredentials()` - Test stored credentials with BuySportsCards

## Usage Examples

### Save Credentials
```typescript
const updateProfile = useMutation(api.userProfile.updateUserProfile);

await updateProfile({
  bscUsername: "user@example.com",
  bscPassword: "password123",
});
```

### Get Profile
```typescript
const profile = useQuery(api.userProfile.getUserProfile);

if (profile?.bscUsername) {
  console.log("User has stored credentials");
}
```

### Test Credentials
```typescript
const testCredentials = useAction(api.userProfile.testBuySportsCardsCredentials);

const result = await testCredentials();
if (result.success) {
  console.log("Credentials are valid!");
}
```

## UI Features

### Profile Page
- Clean, modern interface
- Form validation
- Success/error messaging
- Security information display
- Current status indicators

### Navigation
- Profile icon in header (next to sign out)
- Responsive design
- Hover effects and transitions

## Security Considerations

### Production Deployment
1. **Generate a strong encryption key**: Use a cryptographically secure random key
2. **Environment variables**: Store the encryption key securely
3. **HTTPS**: Ensure all communications are encrypted
4. **Access logs**: Monitor for suspicious access patterns

### Data Protection
- Credentials are never logged
- Encryption happens server-side only
- No plaintext credentials in client-side code
- Automatic credential clearing on sign out

## Troubleshooting

### Common Issues

1. **"Not authenticated" errors**
   - Ensure user is signed in
   - Check authentication state

2. **Encryption errors**
   - Verify ENCRYPTION_KEY is set
   - Ensure key is exactly 32 characters

3. **Profile not loading**
   - Check Convex deployment status
   - Verify schema changes are deployed

4. **Credential test failures**
   - Verify BuySportsCards credentials are correct
   - Check network connectivity
   - Ensure BuySportsCards.com is accessible

### Debug Steps
1. Check browser console for errors
2. Verify environment variables are loaded
3. Test Convex functions directly
4. Check authentication status

## Future Enhancements

### Planned Features
- [ ] Password strength validation
- [ ] Two-factor authentication support
- [ ] Credential expiration management
- [ ] Bulk credential import/export
- [ ] Integration with other platforms

### Security Improvements
- [ ] Key rotation capabilities
- [ ] Audit logging
- [ ] Rate limiting for credential tests
- [ ] Enhanced encryption algorithms

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review Convex documentation
3. Check browser console for errors
4. Verify environment setup

## Migration Notes

If you have existing user data:
1. The new profile system is additive
2. Existing users will have no profile until they create one
3. No data migration is required
4. Users can opt-in to the new system

---

**Note**: This system is designed for development and testing. For production use, ensure all security best practices are followed and the encryption key is properly managed. 