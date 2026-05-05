import { Module, Global } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "../../modules/users/user.entity";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { WorkspaceMemberGuard } from "./workspace-member.guard";

@Global()
@Module({
  imports: [
    StingerloomOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>("JWT_SECRET"),
        signOptions: {
          expiresIn: config.get<string>("JWT_EXPIRES_IN") ?? "1h",
          issuer: "linear-clone",
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, WorkspaceMemberGuard],
  exports: [JwtAuthGuard, WorkspaceMemberGuard, JwtModule, AuthService],
})
export class AuthModule {}
